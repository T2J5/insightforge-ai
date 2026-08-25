import {
  type ResearchRun,
  type RunProgressEvent,
  type RunStatus,
} from "@insightforge/domain";
import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import {
  ResearchRunProcessor,
  type ResearchProgressPublisher,
  type ResearchRunStore,
  type ResearchWorkflow,
} from "./research-run";

const runId = "550e8400-e29b-41d4-a716-446655440000";

const createRun = (status: RunStatus): ResearchRun => ({
  id: runId,
  ownerId: "owner-1",
  company: "示例科技",
  focus: "technology",
  depth: "quick",
  status,
  tokenUsage: 0,
  estimatedCostCny: 0,
  createdAt: new Date("2026-08-17T00:00:00.000Z"),
  updatedAt: new Date("2026-08-17T00:00:00.000Z"),
});

const runningEvent: RunProgressEvent = {
  id: 1,
  runId,
  type: "status",
  status: "running",
  stage: "starting",
  message: "调研任务已由Worker接收",
  progress: 5,
  occurredAt: "2026-08-17T00:00:00.000Z",
  data: {},
};

const createHarness = (
  initialRun: ResearchRun | null = createRun("queued"),
) => {
  const runs: ResearchRunStore = {
    get: vi.fn().mockResolvedValue(initialRun),
    transition: vi.fn().mockResolvedValue(createRun("running")),
  };
  const workflow: ResearchWorkflow = {
    run: vi.fn().mockResolvedValue(undefined),
  };
  const progress: ResearchProgressPublisher = {
    publish: vi.fn().mockResolvedValue(runningEvent),
  };
  const cancellation = {
    assertNotCancelled: vi.fn().mockResolvedValue(undefined),
  };
  const processor = new ResearchRunProcessor(
    runs,
    workflow,
    progress,
    cancellation,
  );

  return { processor, runs, workflow, progress, cancellation };
};

describe("ResearchRunProcessor", () => {
  it("在访问任何依赖以前拒绝非法Job数据", async () => {
    const harness = createHarness();

    await expect(
      harness.processor.process({ runId: "not-a-uuid" }),
    ).rejects.toBeDefined();

    expect(harness.cancellation.assertNotCancelled).not.toHaveBeenCalled();
    expect(harness.runs.get).not.toHaveBeenCalled();
  });

  it("第一次取消检查失败时不读取数据库", async () => {
    const cancellationError = new UnrecoverableError("cancelled");
    const harness = createHarness();
    harness.cancellation.assertNotCancelled.mockRejectedValueOnce(
      cancellationError,
    );

    await expect(harness.processor.process({ runId })).rejects.toBe(
      cancellationError,
    );

    expect(harness.runs.get).not.toHaveBeenCalled();
    expect(harness.workflow.run).not.toHaveBeenCalled();
  });

  it("数据库不存在任务时抛出不可重试错误", async () => {
    const harness = createHarness(null);

    const action = harness.processor.process({ runId });

    await expect(action).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(action).rejects.toThrow(`ResearchRun ${runId} not found`);
    expect(harness.runs.transition).not.toHaveBeenCalled();
    expect(harness.progress.publish).not.toHaveBeenCalled();
  });

  it.each<RunStatus>(["awaiting_review", "completed", "failed", "cancelled"])(
    "任务状态为%s时幂等返回",
    async (status) => {
      const harness = createHarness(createRun(status));

      await expect(
        harness.processor.process({ runId }),
      ).resolves.toBeUndefined();

      expect(harness.runs.transition).not.toHaveBeenCalled();
      expect(harness.cancellation.assertNotCancelled).toHaveBeenCalledOnce();
      expect(harness.progress.publish).not.toHaveBeenCalled();
      expect(harness.workflow.run).not.toHaveBeenCalled();
    },
  );

  it("按状态转换、二次取消检查、进度发布、工作流的顺序处理queued任务", async () => {
    const harness = createHarness();

    await harness.processor.process({ runId });

    expect(harness.runs.get).toHaveBeenCalledWith(runId);
    expect(harness.runs.transition).toHaveBeenCalledWith(
      runId,
      "queued",
      "running",
    );
    expect(harness.cancellation.assertNotCancelled).toHaveBeenCalledTimes(2);
    expect(harness.progress.publish).toHaveBeenCalledWith({
      runId,
      type: "status",
      status: "running",
      stage: "starting",
      message: "调研任务已由Worker接收",
      progress: 5,
      data: {},
    });
    expect(harness.workflow.run).toHaveBeenCalledWith(runId);

    const transitionOrder = vi.mocked(harness.runs.transition).mock
      .invocationCallOrder[0];
    const cancellationOrder =
      harness.cancellation.assertNotCancelled.mock.invocationCallOrder[1];
    const progressOrder = vi.mocked(harness.progress.publish).mock
      .invocationCallOrder[0];
    const workflowOrder = vi.mocked(harness.workflow.run).mock
      .invocationCallOrder[0];

    expect(transitionOrder).toBeLessThan(cancellationOrder!);
    expect(cancellationOrder).toBeLessThan(progressOrder!);
    expect(progressOrder).toBeLessThan(workflowOrder!);
  });

  it("running任务跳过状态转换并恢复工作流", async () => {
    const harness = createHarness(createRun("running"));

    await harness.processor.process({ runId });

    expect(harness.runs.transition).not.toHaveBeenCalled();
    expect(harness.cancellation.assertNotCancelled).toHaveBeenCalledTimes(2);
    expect(harness.progress.publish).toHaveBeenCalledOnce();
    expect(harness.workflow.run).toHaveBeenCalledWith(runId);
  });

  it("状态冲突后发现任务已是running时继续恢复", async () => {
    const harness = createHarness();
    vi.mocked(harness.runs.transition).mockRejectedValueOnce(
      new Error("RUN_STATUS_CONFLICT"),
    );
    vi.mocked(harness.runs.get)
      .mockResolvedValueOnce(createRun("queued"))
      .mockResolvedValueOnce(createRun("running"));

    await harness.processor.process({ runId });

    expect(harness.runs.get).toHaveBeenCalledTimes(2);
    expect(harness.progress.publish).toHaveBeenCalledOnce();
    expect(harness.workflow.run).toHaveBeenCalledOnce();
  });

  it("状态冲突后发现任务已停止时幂等返回", async () => {
    const harness = createHarness();
    vi.mocked(harness.runs.transition).mockRejectedValueOnce(
      new Error("RUN_STATUS_CONFLICT"),
    );
    vi.mocked(harness.runs.get)
      .mockResolvedValueOnce(createRun("queued"))
      .mockResolvedValueOnce(createRun("cancelled"));

    await expect(harness.processor.process({ runId })).resolves.toBeUndefined();

    expect(harness.progress.publish).not.toHaveBeenCalled();
    expect(harness.workflow.run).not.toHaveBeenCalled();
  });

  it("状态冲突后任务消失时抛出不可重试错误", async () => {
    const harness = createHarness();
    vi.mocked(harness.runs.transition).mockRejectedValueOnce(
      new Error("RUN_STATUS_CONFLICT"),
    );
    vi.mocked(harness.runs.get)
      .mockResolvedValueOnce(createRun("queued"))
      .mockResolvedValueOnce(null);

    await expect(harness.processor.process({ runId })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it("传播状态转换的非冲突错误", async () => {
    const databaseError = new Error("database unavailable");
    const harness = createHarness();
    vi.mocked(harness.runs.transition).mockRejectedValueOnce(databaseError);

    await expect(harness.processor.process({ runId })).rejects.toBe(
      databaseError,
    );

    expect(harness.progress.publish).not.toHaveBeenCalled();
    expect(harness.workflow.run).not.toHaveBeenCalled();
  });

  it("第二次取消检查失败时不发布进度或运行工作流", async () => {
    const cancellationError = new UnrecoverableError("cancelled");
    const harness = createHarness();
    harness.cancellation.assertNotCancelled
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(cancellationError);

    await expect(harness.processor.process({ runId })).rejects.toBe(
      cancellationError,
    );

    expect(harness.runs.transition).toHaveBeenCalledOnce();
    expect(harness.progress.publish).not.toHaveBeenCalled();
    expect(harness.workflow.run).not.toHaveBeenCalled();
  });

  it("进度发布失败时不启动工作流", async () => {
    const progressError = new Error("Redis unavailable");
    const harness = createHarness();
    vi.mocked(harness.progress.publish).mockRejectedValueOnce(progressError);

    await expect(harness.processor.process({ runId })).rejects.toBe(
      progressError,
    );

    expect(harness.workflow.run).not.toHaveBeenCalled();
  });

  it("传播工作流错误以便BullMQ执行重试", async () => {
    const workflowError = new Error("model timeout");
    const harness = createHarness();
    vi.mocked(harness.workflow.run).mockRejectedValueOnce(workflowError);

    await expect(harness.processor.process({ runId })).rejects.toBe(
      workflowError,
    );
  });
});
