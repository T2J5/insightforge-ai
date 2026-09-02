import type {
  CitedReportDraft,
  Evidence,
  ResearchRun,
  RunProgressEvent,
  RunStatus,
} from "@insightforge/domain";
import { REQUIRED_REPORT_SECTION_KEYS } from "@insightforge/domain";
import { ResearchExecutionLimitError } from "@insightforge/agent";
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

const budgets = {
  quick: {
    maxSearchCount: 12,
    maxTokenUsage: 80_000,
    maxEstimatedCostCny: 5,
    maxDurationMs: 5 * 60 * 1000,
  },
  deep: {
    maxSearchCount: 30,
    maxTokenUsage: 200_000,
    maxEstimatedCostCny: 15,
    maxDurationMs: 15 * 60 * 1000,
  },
};

const runId = "550e8400-e29b-41d4-a716-446655440000";
const evidenceId = "650e8400-e29b-41d4-a716-446655440000";

const evidence: Evidence = {
  id: evidenceId,
  runId,
  ownerId: "owner-1",
  claim: "OpenAI develops AI systems.",
  sourceType: "web",
  sourceCategory: "official",
  sourceUrl: "https://example.com/openai",
  sourceTitle: "OpenAI overview",
  publisher: "OpenAI",
  publishedAt: null,
  retrievedAt: new Date("2026-08-25T00:00:00.000Z"),
  quote: "OpenAI develops and deploys artificial intelligence systems.",
  documentId: null,
  page: null,
  confidence: 0.9,
  contentHash: "a".repeat(64),
};

const publishedReport: CitedReportDraft = {
  title: "OpenAI 企业调研",
  executiveSummary: [
    {
      markdown: "OpenAI 从事人工智能研究与产品开发。",
      claimType: "fact",
      citationIds: [evidenceId],
    },
  ],
  sections: REQUIRED_REPORT_SECTION_KEYS.map((key) => ({
    key,
    heading: key,
    blocks: [{ markdown: key, claimType: "summary", citationIds: [] }],
  })),
};

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
  runId,
  reportId: runId,
  status: "completed",
  evidenceCandidates: [
    {
      evidenceId: "E1",
      questionId: "q1",
      claim: "OpenAI develops AI systems.",
      sourceUrl: "https://example.com/openai",
      sourceTitle: "OpenAI overview",
      quote: "OpenAI develops and deploys artificial intelligence systems.",
      confidence: 0.9,
    },
  ],
  evidence: [evidence],
  publishedReport,
  qualityWarning: null,
  visitedNodes: ["planner", "researcher", "writer", "publisher"],
  searchCount: 3,
  completedQuestionIds: ["q1", "q2", "q3"],
  startedAt: "2026-08-25T00:00:00.000Z",
  deadlineAt: "2026-08-25T00:05:00.000Z",
  tokenUsage: 120,
  estimatedCostCny: 0.12,
};

const checkpointIdentity = {
  runId,
  reportId: runId,
  ownerId: "owner-1",
  company: "OpenAI",
  focus: "technology" as const,
  depth: "quick" as const,
  startedAt: "2026-08-25T00:00:00.000Z",
  deadlineAt: "2026-08-25T00:05:00.000Z",
};

const completedCheckpoint = {
  ...checkpointIdentity,
  ...agentResult,
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
    getState: vi.fn().mockResolvedValue({
      values: {},
      next: [],
    }),
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
    budgets,
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
    expect(harness.graph.invoke).toHaveBeenCalledWith(
      {
        runId,
        reportId: runId,
        ownerId: "owner-1",
        company: "OpenAI",
        focus: "technology",
        depth: "quick",
        startedAt: "2026-08-25T00:00:00.000Z",
        deadlineAt: "2026-08-25T00:05:00.000Z",
      },
      {
        configurable: {
          thread_id: runId,
        },
        durability: "sync",
      },
    );
    expect(harness.runs.saveCheckpoint).toHaveBeenCalledWith(runId, {
      checkpointKey: "agent-result",
      state: {
        runId,
        reportId: runId,
        evidenceCandidates: agentResult.evidenceCandidates,
        evidence: agentResult.evidence.map((item) => ({
          ...item,
          publishedAt: item.publishedAt?.toISOString() ?? null,
          retrievedAt: item.retrievedAt.toISOString(),
        })),
        publishedReport: agentResult.publishedReport,
        qualityWarning: null,
        visitedNodes: agentResult.visitedNodes,
        searchCount: 3,
        completedQuestionIds: ["q1", "q2", "q3"],
        startedAt: "2026-08-25T00:00:00.000Z",
        deadlineAt: "2026-08-25T00:05:00.000Z",
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

  it("deep 调研使用稳定的十五分钟期限", async () => {
    const harness = createHarness({
      ...createRun(),
      depth: "deep",
    });

    await harness.workflow.run(runId);

    expect(harness.graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        depth: "deep",
        startedAt: "2026-08-25T00:00:00.000Z",
        deadlineAt: "2026-08-25T00:15:00.000Z",
      }),
      {
        configurable: {
          thread_id: runId,
        },
        durability: "sync",
      },
    );
  });

  it("存在未完成 Checkpoint 时使用 null 从待执行节点恢复", async () => {
    const harness = createHarness();
    vi.mocked(harness.graph.getState).mockResolvedValueOnce({
      values: {
        ...checkpointIdentity,
        status: "researching",
      },
      next: ["researcher"],
      createdAt: "2026-08-25T00:01:00.000Z",
    });

    await harness.workflow.run(runId);

    expect(harness.graph.invoke).toHaveBeenCalledOnce();
    expect(harness.graph.invoke).toHaveBeenCalledWith(null, {
      configurable: { thread_id: runId },
      durability: "sync",
    });
    expect(harness.progress.publish).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: "Agent 从 PostgreSQL Checkpoint 恢复执行",
        data: {
          executionMode: "resume",
          pendingNodes: ["researcher"],
        },
      }),
    );
  });

  it("Graph 已完成时直接使用 Checkpoint 完成业务任务", async () => {
    const harness = createHarness();
    vi.mocked(harness.graph.getState).mockResolvedValueOnce({
      values: completedCheckpoint,
      next: [],
      createdAt: "2026-08-25T00:04:00.000Z",
    });

    await harness.workflow.run(runId);

    expect(harness.graph.invoke).not.toHaveBeenCalled();
    expect(harness.runs.saveCheckpoint).toHaveBeenCalledOnce();
    expect(harness.runs.complete).toHaveBeenCalledWith(runId, {
      tokenUsage: agentResult.tokenUsage,
      estimatedCostCny: agentResult.estimatedCostCny,
    });
    expect(harness.progress.publish).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: "Agent 使用已完成 Checkpoint 提交调研结果",
        data: {
          executionMode: "finalize",
          pendingNodes: [],
        },
      }),
    );
  });

  it("Checkpoint 身份与当前 Run 不一致时禁止恢复", async () => {
    const harness = createHarness();
    vi.mocked(harness.graph.getState).mockResolvedValueOnce({
      values: {
        ...checkpointIdentity,
        company: "Another company",
      },
      next: ["researcher"],
      createdAt: "2026-08-25T00:01:00.000Z",
    });

    await expect(harness.workflow.run(runId)).rejects.toEqual(
      expect.objectContaining({
        name: "UnrecoverableError",
        message: "AGENT_CHECKPOINT_IDENTITY_CONFLICT",
      }),
    );
    expect(harness.graph.invoke).not.toHaveBeenCalled();
    expect(harness.runs.complete).not.toHaveBeenCalled();
  });

  it("已结束但损坏的 Checkpoint 不能完成业务任务", async () => {
    const harness = createHarness();
    vi.mocked(harness.graph.getState).mockResolvedValueOnce({
      values: {
        ...checkpointIdentity,
        status: "completed",
        publishedReport: null,
      },
      next: [],
      createdAt: "2026-08-25T00:04:00.000Z",
    });

    await expect(harness.workflow.run(runId)).rejects.toEqual(
      expect.objectContaining({
        name: "UnrecoverableError",
        message: "AGENT_CHECKPOINT_INVALID",
      }),
    );
    expect(harness.graph.invoke).not.toHaveBeenCalled();
    expect(harness.runs.complete).not.toHaveBeenCalled();
  });

  it("Agent 返回其他 runId 时禁止保存检查点或完成任务", async () => {
    const harness = createHarness();
    vi.mocked(harness.graph.invoke).mockResolvedValueOnce({
      ...agentResult,
      runId: "c0a80121-7ac0-4b18-9f20-6d9ad634b573",
    });

    await expect(harness.workflow.run(runId)).rejects.toThrow(
      "AGENT_RUN_ID_MISMATCH",
    );

    expect(harness.cancellation.assertNotCancelled).toHaveBeenCalledOnce();
    expect(harness.runs.saveCheckpoint).not.toHaveBeenCalled();
    expect(harness.runs.complete).not.toHaveBeenCalled();
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

  it("预算耗尽转换成 BullMQ 不可重试错误", async () => {
    const harness = createHarness();
    vi.mocked(harness.graph.invoke).mockRejectedValueOnce(
      new ResearchExecutionLimitError("AGENT_TOKEN_BUDGET_EXCEEDED"),
    );

    await expect(harness.workflow.run(runId)).rejects.toEqual(
      expect.objectContaining({
        name: "UnrecoverableError",
        message: "AGENT_TOKEN_BUDGET_EXCEEDED",
      }),
    );
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
