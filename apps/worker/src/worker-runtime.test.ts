import { describe, expect, it, vi } from "vitest";

import {
  WorkerRuntime,
  type ManagedResearchWorker,
  type WorkerRuntimeDependencies,
} from "./worker-runtime";

const createHarness = () => {
  const calls: string[] = [];
  const worker: ManagedResearchWorker = {
    waitUntilReady: vi.fn(async () => {
      calls.push("worker.ready");
    }),
    close: vi.fn(async () => {
      calls.push("worker.close");
    }),
  };
  const dependencies: WorkerRuntimeDependencies = {
    worker,
    closeRedis: vi.fn(async () => {
      calls.push("redis.close");
    }),
    closeDatabase: vi.fn(async () => {
      calls.push("database.close");
    }),
    closeCheckpointer: vi.fn(async () => {
      calls.push("checkpointer.close");
    }),
  };

  return {
    calls,
    worker,
    dependencies,
    runtime: new WorkerRuntime(dependencies),
  };
};

describe("WorkerRuntime", () => {
  it("等待 BullMQ Worker 就绪，重复启动不会重复执行", async () => {
    const harness = createHarness();

    await Promise.all([harness.runtime.start(), harness.runtime.start()]);

    expect(harness.worker.waitUntilReady).toHaveBeenCalledOnce();
    expect(harness.calls).toEqual(["worker.ready"]);
  });

  it("先关闭 Worker，再关闭 Redis 和 PostgreSQL", async () => {
    const harness = createHarness();

    await harness.runtime.start();
    await harness.runtime.close();

    expect(harness.calls[0]).toBe("worker.ready");
    expect(harness.calls[1]).toBe("worker.close");
    expect(harness.calls.slice(2).sort()).toEqual([
      "checkpointer.close",
      "database.close",
      "redis.close",
    ]);
  });

  it("并发或重复关闭时只执行一次资源清理", async () => {
    const harness = createHarness();

    await Promise.all([
      harness.runtime.close(),
      harness.runtime.close(),
      harness.runtime.close(),
    ]);

    expect(harness.worker.close).toHaveBeenCalledOnce();
    expect(harness.dependencies.closeRedis).toHaveBeenCalledOnce();
    expect(harness.dependencies.closeDatabase).toHaveBeenCalledOnce();
    expect(harness.dependencies.closeCheckpointer).toHaveBeenCalledOnce();
  });

  it("某个关闭步骤失败时仍尝试释放全部资源并返回稳定错误", async () => {
    const harness = createHarness();
    vi.mocked(harness.worker.close).mockRejectedValueOnce(
      new Error("bullmq socket secret"),
    );
    vi.mocked(harness.dependencies.closeRedis).mockRejectedValueOnce(
      new Error("redis socket secret"),
    );

    await expect(harness.runtime.close()).rejects.toThrow(
      "WORKER_SHUTDOWN_FAILED",
    );
    expect(harness.worker.close).toHaveBeenCalledOnce();
    expect(harness.dependencies.closeRedis).toHaveBeenCalledOnce();
    expect(harness.dependencies.closeDatabase).toHaveBeenCalledOnce();
    expect(harness.dependencies.closeCheckpointer).toHaveBeenCalledOnce();
  });

  it("关闭开始后不允许重新启动", async () => {
    const harness = createHarness();

    await harness.runtime.close();

    await expect(harness.runtime.start()).rejects.toThrow(
      "WORKER_RUNTIME_CLOSED",
    );
  });
});
