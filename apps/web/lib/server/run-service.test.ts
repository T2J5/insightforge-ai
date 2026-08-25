import type { ResearchRun, RunCheckpoint } from "@insightforge/domain";
import { describe, expect, it, vi } from "vitest";
import {
  RunCancellationError,
  RunDispatchError,
  RunQueryError,
  RunService,
} from "./run-service";

const runId = "550e8400-e29b-41d4-a716-446655440000";

const checkpointId = "650e8400-e29b-41d4-a716-446655440000";

const documentId = "750e8400-e29b-41d4-a716-446655440000";

const now = new Date("2026-08-15T08:00:00.000Z");

const createdRun: ResearchRun = {
  id: runId,
  ownerId: "user-1",
  company: "ByteDance",
  focus: "comprehensive",
  depth: "quick",
  status: "queued",
  tokenUsage: 0,
  estimatedCostCny: 0,
  createdAt: now,
  updatedAt: now,
};
const failedRun: ResearchRun = {
  ...createdRun,
  status: "failed",
  updatedAt: new Date("2026-08-15T08:01:00.000Z"),
};
const cancelledRun: ResearchRun = {
  ...createdRun,
  status: "cancelled",
  updatedAt: new Date("2026-08-15T08:02:00.000Z"),
};

const savedCheckpoint: RunCheckpoint = {
  id: checkpointId,
  runId,
  checkpointKey: "request",
  state: {
    company: "ByteDance",
    focus: "comprehensive",
    depth: "quick",
    documentIds: [documentId],
  },
  createdAt: now,
  updatedAt: now,
};

describe("RunService.createRun", () => {
  it("先持久化queued任务和请求检查点，再添加队列任务", async () => {
    const runRepository = {
      create: vi.fn().mockResolvedValue(createdRun),
      saveCheckpoint: vi.fn().mockResolvedValue(savedCheckpoint),
      transition: vi.fn(),
      get: vi.fn(),
    };
    const queue = {
      add: vi.fn().mockResolvedValue({ id: runId }),
    };

    const cancellationStore = {
      set: vi.fn().mockResolvedValue("OK"),
    };

    const service = new RunService(runRepository, queue, cancellationStore);

    const result = await service.createRun("user-1", {
      company: " ByteDance",
      focus: "comprehensive",
      depth: "quick",
      documentIds: [documentId],
    });

    expect(result).toEqual(createdRun);
    expect(runRepository.create).toHaveBeenCalledWith({
      ownerId: "user-1",
      company: "ByteDance",
      focus: "comprehensive",
      depth: "quick",
    });

    expect(runRepository.saveCheckpoint).toHaveBeenCalledWith(runId, {
      checkpointKey: "request",
      state: {
        company: "ByteDance",
        focus: "comprehensive",
        depth: "quick",
        documentIds: [documentId],
      },
    });
    expect(queue.add).toHaveBeenCalledWith(
      "research-run",
      {
        runId,
      },
      {
        jobId: runId,
      },
    );

    const createOrder = runRepository.create.mock.invocationCallOrder[0];

    const checkpointOrder =
      runRepository.saveCheckpoint.mock.invocationCallOrder[0];

    const enqueueOrder = queue.add.mock.invocationCallOrder[0];

    expect(createOrder!).toBeLessThan(checkpointOrder!);
    expect(checkpointOrder!).toBeLessThan(enqueueOrder!);

    expect(runRepository.transition).not.toHaveBeenCalled();
  });
  it("checkpoint保存失败时把queued任务标记为failed且不入队", async () => {
    const runRepository = {
      create: vi.fn().mockResolvedValue(createdRun),
      saveCheckpoint: vi
        .fn()
        .mockRejectedValue(new Error("checkpoint database unavailable")),
      transition: vi.fn().mockResolvedValue(failedRun),
      get: vi.fn(),
    };
    const queue = {
      add: vi.fn(),
    };
    const cancellationStore = {
      set: vi.fn().mockResolvedValue("OK"),
    };
    const service = new RunService(runRepository, queue, cancellationStore);

    await expect(
      service.createRun("user-1", {
        company: " ByteDance",
        focus: "comprehensive",
        depth: "quick",
        documentIds: [documentId],
      }),
    ).rejects.toMatchObject({
      name: "RunDispatchError",
      code: "RUN_DISPATCH_FAILED",
    });

    expect(runRepository.transition).toHaveBeenCalledWith(
      runId,
      "queued",
      "failed",
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("队列入队失败时把queued任务标记为failed", async () => {
    const runRepository = {
      create: vi.fn().mockResolvedValue(createdRun),
      saveCheckpoint: vi.fn().mockResolvedValue(savedCheckpoint),
      transition: vi.fn().mockResolvedValue(failedRun),
      get: vi.fn(),
    };
    const queue = {
      add: vi.fn().mockRejectedValue(new Error("redis unavailable")),
    };
    const cancellationStore = {
      set: vi.fn().mockResolvedValue("OK"),
    };
    const service = new RunService(runRepository, queue, cancellationStore);
    await expect(
      service.createRun("user-1", {
        company: " ByteDance",
        focus: "comprehensive",
        depth: "quick",
        documentIds: [documentId],
      }),
    ).rejects.toMatchObject({
      name: "RunDispatchError",
      code: "RUN_DISPATCH_FAILED",
    });

    expect(queue.add).toHaveBeenCalledWith(
      "research-run",
      {
        runId,
      },
      {
        jobId: runId,
      },
    );

    expect(runRepository.transition).toHaveBeenCalledWith(
      runId,
      "queued",
      "failed",
    );
  });
  it("补偿状态迁移也失败时同时保留原始错误和补偿错误", async () => {
    const dispatchCause = new Error("redis unavailable");

    const compensationCause = new Error("database transition unavailable");

    const runRepository = {
      create: vi.fn().mockResolvedValue(createdRun),

      saveCheckpoint: vi.fn().mockResolvedValue(savedCheckpoint),

      transition: vi.fn().mockRejectedValue(compensationCause),
      get: vi.fn(),
    };

    const queue = {
      add: vi.fn().mockRejectedValue(dispatchCause),
    };

    const cancellationStore = {
      set: vi.fn().mockResolvedValue("OK"),
    };

    const service = new RunService(runRepository, queue, cancellationStore);

    let caughtError: unknown;

    try {
      await service.createRun("user-1", {
        company: "ByteDance",
        focus: "comprehensive",
        depth: "quick",
        documentIds: [documentId],
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(RunDispatchError);

    /**
     * instanceof 判断同时承担运行时保护和类型缩小。
     */
    if (!(caughtError instanceof RunDispatchError)) {
      throw new Error("Expected createRun to throw RunDispatchError");
    }

    expect(caughtError.code).toBe("RUN_DISPATCH_FAILED");

    expect(caughtError.cause).toBe(dispatchCause);

    expect(caughtError.compensationError).toBe(compensationCause);

    expect(runRepository.transition).toHaveBeenCalledWith(
      runId,
      "queued",
      "failed",
    );
  });
});

describe("RunService.cancelRun", () => {
  const createCancelHarness = (run: ResearchRun | null) => {
    const runRepository = {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(run),
      saveCheckpoint: vi.fn(),
      transition: vi.fn().mockResolvedValue(cancelledRun),
    };

    const queue = {
      add: vi.fn(),
    };

    const cancellationStore = {
      set: vi.fn().mockResolvedValue("OK"),
    };

    const service = new RunService(runRepository, queue, cancellationStore);

    return { service, runRepository, cancellationStore };
  };

  it("取消属于当前用户的queued任务并写入24小时Redis标记", async () => {
    const runRepository = {
      create: vi.fn(),

      get: vi.fn().mockResolvedValue(createdRun),

      saveCheckpoint: vi.fn(),

      transition: vi.fn().mockResolvedValue(cancelledRun),
    };

    const queue = {
      add: vi.fn(),
    };

    const cancellationStore = {
      set: vi.fn().mockResolvedValue("OK"),
    };

    const service = new RunService(runRepository, queue, cancellationStore);

    await expect(service.cancelRun("user-1", runId)).resolves.toBeUndefined();

    expect(runRepository.get).toHaveBeenCalledWith(runId);

    expect(runRepository.transition).toHaveBeenCalledWith(
      runId,
      "queued",
      "cancelled",
    );

    expect(cancellationStore.set).toHaveBeenCalledWith(
      `run:${runId}:cancelled`,
      "1",
      "EX",
      24 * 60 * 60,
    );

    const transitionOrder =
      runRepository.transition.mock.invocationCallOrder[0];

    const signalOrder = cancellationStore.set.mock.invocationCallOrder[0];

    expect(transitionOrder).toBeDefined();
    expect(signalOrder).toBeDefined();

    expect(transitionOrder!).toBeLessThan(signalOrder!);
  });

  it("任务不存在时返回RUN_NOT_FOUND且不写取消标记", async () => {
    const { service, runRepository, cancellationStore } =
      createCancelHarness(null);

    await expect(service.cancelRun("user-1", runId)).rejects.toMatchObject({
      name: "RunCancellationError",
      code: "RUN_NOT_FOUND",
    });

    expect(runRepository.transition).not.toHaveBeenCalled();
    expect(cancellationStore.set).not.toHaveBeenCalled();
  });

  it("其他用户的任务同样返回RUN_NOT_FOUND", async () => {
    const anotherUsersRun: ResearchRun = {
      ...createdRun,
      ownerId: "user-2",
    };

    const { service, runRepository, cancellationStore } =
      createCancelHarness(anotherUsersRun);

    await expect(service.cancelRun("user-1", runId)).rejects.toMatchObject({
      name: "RunCancellationError",
      code: "RUN_NOT_FOUND",
    });

    expect(runRepository.transition).not.toHaveBeenCalled();
    expect(cancellationStore.set).not.toHaveBeenCalled();
  });

  it.each(["running", "awaiting_review"] as const)(
    "允许取消%s状态的任务",
    async (status) => {
      const run: ResearchRun = { ...createdRun, status };
      const { service, runRepository, cancellationStore } =
        createCancelHarness(run);

      await expect(service.cancelRun("user-1", runId)).resolves.toBeUndefined();

      expect(runRepository.transition).toHaveBeenCalledWith(
        runId,
        status,
        "cancelled",
      );
      expect(cancellationStore.set).toHaveBeenCalledWith(
        `run:${runId}:cancelled`,
        "1",
        "EX",
        24 * 60 * 60,
      );
    },
  );

  it.each(["completed", "failed"] as const)(
    "拒绝取消%s状态的任务",
    async (status) => {
      const run: ResearchRun = { ...createdRun, status };
      const { service, runRepository, cancellationStore } =
        createCancelHarness(run);

      await expect(service.cancelRun("user-1", runId)).rejects.toMatchObject({
        name: "RunCancellationError",
        code: "RUN_NOT_CANCELLABLE",
      });

      expect(runRepository.transition).not.toHaveBeenCalled();
      expect(cancellationStore.set).not.toHaveBeenCalled();
    },
  );

  it("重复取消不迁移数据库但重新写入Redis标记", async () => {
    const alreadyCancelledRun: ResearchRun = {
      ...createdRun,
      status: "cancelled",
    };

    const { service, runRepository, cancellationStore } =
      createCancelHarness(alreadyCancelledRun);

    await expect(service.cancelRun("user-1", runId)).resolves.toBeUndefined();

    expect(runRepository.transition).not.toHaveBeenCalled();
    expect(cancellationStore.set).toHaveBeenCalledWith(
      `run:${runId}:cancelled`,
      "1",
      "EX",
      24 * 60 * 60,
    );
  });

  it("Redis取消标记写入失败时保留原始错误", async () => {
    const redisCause = new Error("redis unavailable");
    const { service, runRepository, cancellationStore } =
      createCancelHarness(createdRun);

    cancellationStore.set.mockRejectedValueOnce(redisCause);

    let caughtError: unknown;

    try {
      await service.cancelRun("user-1", runId);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(RunCancellationError);

    if (!(caughtError instanceof RunCancellationError)) {
      throw new Error("Expected cancelRun to throw RunCancellationError");
    }

    expect(caughtError.code).toBe("RUN_CANCELLATION_SIGNAL_FAILED");
    expect(caughtError.cause).toBe(redisCause);
    expect(runRepository.transition).toHaveBeenCalledWith(
      runId,
      "queued",
      "cancelled",
    );
  });
});

describe("RunService.getRun", () => {
  const createQueryHarness = (run: ResearchRun | null) => {
    const runRepository = {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(run),
      saveCheckpoint: vi.fn(),
      transition: vi.fn(),
    };
    const service = new RunService(
      runRepository,
      { add: vi.fn() },
      { set: vi.fn() },
    );

    return { service, runRepository };
  };

  it("返回属于当前用户的任务", async () => {
    const { service, runRepository } = createQueryHarness(createdRun);

    await expect(service.getRun("user-1", runId)).resolves.toBe(createdRun);
    expect(runRepository.get).toHaveBeenCalledWith(runId);
  });

  it("任务不存在时返回RUN_NOT_FOUND", async () => {
    const { service } = createQueryHarness(null);

    await expect(service.getRun("user-1", runId)).rejects.toMatchObject({
      name: "RunQueryError",
      code: "RUN_NOT_FOUND",
    });
  });

  it("其他用户的任务返回相同的RUN_NOT_FOUND", async () => {
    const { service } = createQueryHarness({
      ...createdRun,
      ownerId: "user-2",
    });

    let caughtError: unknown;
    try {
      await service.getRun("user-1", runId);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(RunQueryError);
    expect(caughtError).toMatchObject({
      name: "RunQueryError",
      code: "RUN_NOT_FOUND",
    });
  });

  it("非法runId在访问Repository以前被拒绝", async () => {
    const { service, runRepository } = createQueryHarness(createdRun);

    await expect(service.getRun("user-1", "not-a-uuid")).rejects.toBeDefined();
    expect(runRepository.get).not.toHaveBeenCalled();
  });
});
