import type {
  ResearchRun,
  RunProgressEvent,
  RunStatus,
} from "@insightforge/domain";
import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import {
  ResearchRunFailureHandler,
  type FailedResearchJob,
  type FailedRunProgressPublisher,
  type FailedRunStore,
} from "./run-failure-handler";

const runId = "550e8400-e29b-41d4-a716-446655440000";

const createRun = (status: RunStatus = "running"): ResearchRun => ({
  id: runId,
  ownerId: "owner-1",
  company: "OpenAI",
  focus: "technology",
  depth: "quick",
  status,
  tokenUsage: 0,
  estimatedCostCny: 0,
  createdAt: new Date("2026-08-25T00:00:00.000Z"),
  updatedAt: new Date("2026-08-25T00:00:00.000Z"),
});

const failedEvent: RunProgressEvent = {
  id: 1,
  runId,
  type: "status",
  status: "failed",
  stage: "failed",
  message: "调研任务执行失败，请稍后重试",
  progress: 100,
  occurredAt: "2026-08-25T00:00:00.000Z",
  data: { code: "RESEARCH_RUN_FAILED" },
};

const createJob = (
  attemptsMade: number,
  attempts: number = 4,
): FailedResearchJob => ({
  data: { runId },
  attemptsMade,
  opts: { attempts },
});

const createHarness = (run: ResearchRun | null = createRun()) => {
  const runs: FailedRunStore = {
    get: vi.fn().mockResolvedValue(run),
    transition: vi.fn().mockResolvedValue(createRun("failed")),
  };
  const progress: FailedRunProgressPublisher = {
    publish: vi.fn().mockResolvedValue(failedEvent),
  };
  const handler = new ResearchRunFailureHandler(runs, progress);

  return { handler, runs, progress };
};

describe("ResearchRunFailureHandler", () => {
  it("没有 Job 或 Job 数据非法时忽略事件", async () => {
    const harness = createHarness();

    await harness.handler.handle(undefined, new Error("failed"));
    await harness.handler.handle(
      { ...createJob(4), data: { runId: "not-a-uuid" } },
      new Error("failed"),
    );

    expect(harness.runs.get).not.toHaveBeenCalled();
  });

  it("普通错误仍有重试次数时保持 running", async () => {
    const harness = createHarness();

    await harness.handler.handle(createJob(1), new Error("model timeout"));

    expect(harness.runs.get).not.toHaveBeenCalled();
    expect(harness.runs.transition).not.toHaveBeenCalled();
    expect(harness.progress.publish).not.toHaveBeenCalled();
  });

  it("最后一次失败时转换状态并发布脱敏终态事件", async () => {
    const harness = createHarness();

    await harness.handler.handle(
      createJob(4),
      new Error("secret provider response"),
    );

    expect(harness.runs.transition).toHaveBeenCalledWith(
      runId,
      "running",
      "failed",
    );
    expect(harness.progress.publish).toHaveBeenCalledWith({
      runId,
      type: "status",
      status: "failed",
      stage: "failed",
      message: "调研任务执行失败，请稍后重试",
      progress: 100,
      data: { code: "RESEARCH_RUN_FAILED" },
    });
    expect(
      JSON.stringify(vi.mocked(harness.progress.publish).mock.calls),
    ).not.toContain("secret provider response");
  });

  it("不可重试错误无需耗尽 attempts", async () => {
    const harness = createHarness();

    await harness.handler.handle(
      createJob(1),
      new UnrecoverableError("permanent failure"),
    );

    expect(harness.runs.transition).toHaveBeenCalledOnce();
  });

  it.each<RunStatus>(["queued", "completed", "failed", "cancelled"])(
    "数据库状态为 %s 时不覆盖成 failed",
    async (status) => {
      const harness = createHarness(createRun(status));

      await harness.handler.handle(createJob(4), new Error("failed"));

      expect(harness.runs.transition).not.toHaveBeenCalled();
      expect(harness.progress.publish).not.toHaveBeenCalled();
    },
  );

  it("并发状态冲突时认为其他操作已经获胜", async () => {
    const harness = createHarness();
    vi.mocked(harness.runs.transition).mockRejectedValueOnce(
      new Error("RUN_STATUS_CONFLICT"),
    );

    await expect(
      harness.handler.handle(createJob(4), new Error("failed")),
    ).resolves.toBeUndefined();
    expect(harness.progress.publish).not.toHaveBeenCalled();
  });

  it("传播非状态冲突的数据库错误", async () => {
    const harness = createHarness();
    const databaseError = new Error("database unavailable");
    vi.mocked(harness.runs.transition).mockRejectedValueOnce(databaseError);

    await expect(
      harness.handler.handle(createJob(4), new Error("failed")),
    ).rejects.toBe(databaseError);
  });
});
