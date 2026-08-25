import type {
  ResearchRun,
  RunProgressEvent,
  RunStatus,
} from "@insightforge/domain";
import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import {
  AgentResearchWorkflow,
  type AgentWorkflowCancellationGuard,
  type AgentWorkflowProgressPublisher,
  type AgentWorkflowRunStore,
  type ResearchAgentResult,
  type ResearchAgentRunner,
} from "./agent-workflow";

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

const agentResult: ResearchAgentResult = {
  status: "completed",
  evidenceCandidates: [
    {
      evidenceId: "E1",
      claim: "OpenAI develops AI systems.",
    },
  ],
  publishedReport: {
    title: "OpenAI 企业调研",
    executiveSummary: "OpenAI 从事人工智能研究与产品开发。",
  },
  qualityWarning: null,
  visitedNodes: ["planner", "researcher", "writer", "publisher"],
  tokenUsage: 120,
  estimatedCostCny: 0.12,
};

const progressEvent = (id: number, status: RunStatus): RunProgressEvent => ({
  id,
  runId,
  type: status === "completed" ? "status" : "progress",
  status,
  stage: status === "completed" ? "completed" : "planning",
  message: status === "completed" ? "企业调研报告已生成" : "开始规划",
  progress: status === "completed" ? 100 : 10,
  occurredAt: `2026-08-25T00:00:0${id}.000Z`,
  data: {},
});

const createHarness = (run: ResearchRun | null = createRun()) => {
  const runs: AgentWorkflowRunStore = {
    get: vi.fn().mockResolvedValue(run),
    complete: vi.fn().mockResolvedValue(createRun("completed")),
    saveCheckpoint: vi.fn().mockResolvedValue(undefined),
  };
  const graph: ResearchAgentRunner = {
    invoke: vi.fn().mockResolvedValue(agentResult),
  };
  const progress: AgentWorkflowProgressPublisher = {
    publish: vi
      .fn()
      .mockResolvedValueOnce(progressEvent(1, "running"))
      .mockResolvedValueOnce(progressEvent(2, "completed")),
  };
  const cancellation: AgentWorkflowCancellationGuard = {
    assertNotCancelled: vi.fn().mockResolvedValue(undefined),
  };
  const workflow = new AgentResearchWorkflow(
    runs,
    graph,
    progress,
    cancellation,
  );

  return { workflow, runs, graph, progress, cancellation };
};

describe("AgentResearchWorkflow", () => {
  it("不存在的 Run 使用不可重试错误停止", async () => {
    const harness = createHarness(null);

    await expect(harness.workflow.run(runId)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(harness.graph.invoke).not.toHaveBeenCalled();
  });

  it("只允许运行 running 状态的任务", async () => {
    const harness = createHarness(createRun("queued"));

    await expect(harness.workflow.run(runId)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(harness.cancellation.assertNotCancelled).not.toHaveBeenCalled();
  });

  it("执行 Agent、保存结果后再完成任务并发布终态", async () => {
    const harness = createHarness();

    await harness.workflow.run(runId);

    expect(harness.cancellation.assertNotCancelled).toHaveBeenCalledTimes(2);
    expect(harness.graph.invoke).toHaveBeenCalledWith({
      company: "OpenAI",
      focus: "technology",
      depth: "quick",
    });
    expect(harness.runs.saveCheckpoint).toHaveBeenCalledWith(runId, {
      checkpointKey: "agent-result",
      state: {
        evidenceCandidates: agentResult.evidenceCandidates,
        publishedReport: agentResult.publishedReport,
        qualityWarning: null,
        visitedNodes: agentResult.visitedNodes,
        tokenUsage: 120,
        estimatedCostCny: 0.12,
      },
    });
    expect(harness.runs.complete).toHaveBeenCalledWith(runId, {
      tokenUsage: 120,
      estimatedCostCny: 0.12,
    });
    expect(harness.progress.publish).toHaveBeenLastCalledWith({
      runId,
      type: "status",
      status: "completed",
      stage: "completed",
      message: "企业调研报告已生成",
      progress: 100,
      data: {
        tokenUsage: 120,
        estimatedCostCny: 0.12,
      },
    });

    const saveOrder = vi.mocked(harness.runs.saveCheckpoint).mock
      .invocationCallOrder[0]!;
    const completeOrder = vi.mocked(harness.runs.complete).mock
      .invocationCallOrder[0]!;
    const completedProgressOrder = vi.mocked(harness.progress.publish).mock
      .invocationCallOrder[1]!;
    expect(saveOrder).toBeLessThan(completeOrder);
    expect(completeOrder).toBeLessThan(completedProgressOrder);
  });

  it("Agent 执行后检测到取消时不保存或完成任务", async () => {
    const harness = createHarness();
    vi.mocked(harness.cancellation.assertNotCancelled)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new UnrecoverableError("cancelled"));

    await expect(harness.workflow.run(runId)).rejects.toThrow("cancelled");

    expect(harness.graph.invoke).toHaveBeenCalledOnce();
    expect(harness.runs.saveCheckpoint).not.toHaveBeenCalled();
    expect(harness.runs.complete).not.toHaveBeenCalled();
  });

  it("Agent 没有完成或没有报告时不保存结果", async () => {
    const harness = createHarness();
    vi.mocked(harness.graph.invoke).mockResolvedValueOnce({
      ...agentResult,
      status: "reviewing",
      publishedReport: null,
    });

    await expect(harness.workflow.run(runId)).rejects.toThrow(
      "AGENT_WORKFLOW_NOT_COMPLETED",
    );
    expect(harness.runs.saveCheckpoint).not.toHaveBeenCalled();
    expect(harness.runs.complete).not.toHaveBeenCalled();
  });

  it("检查点保存失败时不能把任务标记成 completed", async () => {
    const harness = createHarness();
    vi.mocked(harness.runs.saveCheckpoint).mockRejectedValueOnce(
      new Error("checkpoint unavailable"),
    );

    await expect(harness.workflow.run(runId)).rejects.toThrow(
      "checkpoint unavailable",
    );
    expect(harness.runs.complete).not.toHaveBeenCalled();
  });
});
