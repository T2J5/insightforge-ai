import {
  JsonObjectSchema,
  type CompleteResearchRunInput,
  type ResearchDepth,
  type ResearchFocus,
  type ResearchRun,
  type RunCheckpointInput,
  type RunProgressEvent,
} from "@insightforge/domain";
import type { ResearchWorkflow } from "./processors/research-run";
import { UnrecoverableError } from "bullmq";
import type { PublishProgressInput } from "./progress-publisher";
import {
  isResearchExecutionLimitError,
  type ResearchBudgets,
} from "@insightforge/agent";

export interface AgentWorkflowRunStore {
  get(runId: string): Promise<ResearchRun | null>;

  complete(
    runId: string,
    input: CompleteResearchRunInput,
  ): Promise<ResearchRun>;

  saveCheckpoint(runId: string, input: RunCheckpointInput): Promise<unknown>;
}

export interface AgentWorkflowCancellationGuard {
  assertNotCancelled(runId: string): Promise<void>;
}
export interface AgentWorkflowProgressPublisher {
  publish(input: PublishProgressInput): Promise<RunProgressEvent>;
}

export interface ResearchAgentResult {
  runId: string;
  status: string;
  evidenceCandidates: unknown[];
  publishedReport: unknown;
  qualityWarning: string | null;
  visitedNodes: string[];
  searchCount: number;
  completedQuestionIds: string[];
  startedAt: string;
  deadlineAt: string;
  tokenUsage: number;
  estimatedCostCny: number;
}

export interface ResearchAgentRunner {
  invoke(input: {
    runId: string;
    company: string;
    focus: ResearchFocus;
    depth: ResearchDepth;
    startedAt: string;
    deadlineAt: string;
  }): Promise<ResearchAgentResult>;
}

/**
 * 把 packages/agent 中的 LangGraph，
 * 适配成 ResearchRunProcessor 需要的 ResearchWorkflow。
 */
export class AgentResearchWorkflow implements ResearchWorkflow {
  constructor(
    private readonly runs: AgentWorkflowRunStore,
    private readonly graph: ResearchAgentRunner,
    private readonly progress: AgentWorkflowProgressPublisher,
    private readonly cancellation: AgentWorkflowCancellationGuard,
    private readonly budgets: ResearchBudgets,
  ) {}

  async run(runId: string): Promise<void> {
    const run = await this.runs.get(runId);
    if (!run) {
      throw new UnrecoverableError(`ResearchRun ${runId} not found`);
    }
    /**
     * ResearchRunProcessor 在调用 Workflow 前
     * 应该已经把状态转换成 running。
     */
    if (run.status !== "running") {
      throw new UnrecoverableError(
        `ResearchRun ${runId} is not in running state`,
      );
    }

    await this.cancellation.assertNotCancelled(runId);

    await this.progress.publish({
      runId,
      type: "progress",
      status: "running",
      stage: "planning",
      message: "Agent 开始规划企业调研任务",
      progress: 10,
      data: {},
    });
    /**
     * run.updatedAt 是任务进入 running 时由 Repository 更新的时间。
     *
     * Worker 重试 running 任务时不会重新生成 startedAt，
     * 因此 deadlineAt 也保持稳定，不会因为重试不断向后延长。
     */
    const startedAt = run.updatedAt;
    const deadlineAt = new Date(
      startedAt.getTime() + this.budgets[run.depth].maxDurationMs,
    );
    /**
     * 当前使用 invoke 获取最终状态。
     *
     * 后续任务会升级为 graph.stream，
     * 在每个 Agent 节点之间执行取消检查和进度发布。
     */
    let result: ResearchAgentResult;
    try {
      result = await this.graph.invoke({
        runId,
        company: run.company,
        focus: run.focus,
        depth: run.depth,
        startedAt: startedAt.toISOString(),
        deadlineAt: deadlineAt.toISOString(),
      });
    } catch (error) {
      /**
       * 预算和总期限耗尽后重试没有意义，
       * 转为 BullMQ 不可重试错误。
       */
      if (isResearchExecutionLimitError(error)) {
        throw new UnrecoverableError(error.code);
      }
      throw error;
    }

    /**
     * 防止错误的检查点或 Graph Adapter
     * 把其他 Run 的结果保存到当前任务。
     */
    if (result.runId !== runId) {
      throw new Error(`AGENT_RUN_ID_MISMATCH`);
    }
    await this.cancellation.assertNotCancelled(runId);
    if (result.status !== "completed" || result.publishedReport === null) {
      throw new Error(`AGENT_WORKFLOW_NOT_COMPLETED`);
    }
    /**
     * Task 3 先把 Agent 输出保存成检查点，
     * 防止 Worker 执行完成后报告只存在于内存。
     *
     * EvidenceRepository 和 ReportRepository 的正式写入
     * 留到后续持久化集成任务。
     */
    const checkpointState = JsonObjectSchema.parse(
      JSON.parse(
        JSON.stringify({
          runId: result.runId,
          evidenceCandidates: result.evidenceCandidates,
          publishedReport: result.publishedReport,
          qualityWarning: result.qualityWarning,
          visitedNodes: result.visitedNodes,
          searchCount: result.searchCount,
          completedQuestionIds: result.completedQuestionIds,
          startedAt: result.startedAt,
          deadlineAt: result.deadlineAt,
          tokenUsage: result.tokenUsage,
          estimatedCostCny: result.estimatedCostCny,
        }),
      ),
    );
    await this.runs.saveCheckpoint(runId, {
      checkpointKey: "agent-result",
      state: checkpointState,
    });
    /**
     * 保存结果后才允许把业务任务标记成 completed。
     */
    await this.runs.complete(runId, {
      tokenUsage: result.tokenUsage,
      estimatedCostCny: result.estimatedCostCny,
    });

    await this.progress.publish({
      runId,
      type: "status",
      status: "completed",
      stage: "completed",
      message: "企业调研报告已生成",
      progress: 100,
      data: {
        tokenUsage: result.tokenUsage,
        estimatedCostCny: result.estimatedCostCny,
      },
    });
  }
}
