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
  status: string;
  evidenceCandidates: unknown[];
  publishedReport: unknown;
  qualityWarning: string | null;
  visitedNodes: string[];
  tokenUsage: number;
  estimatedCostCny: number;
}

export interface ResearchAgentRunner {
  invoke(input: {
    company: string;
    focus: ResearchFocus;
    depth: ResearchDepth;
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
     * 当前使用 invoke 获取最终状态。
     *
     * 后续任务会升级为 graph.stream，
     * 在每个 Agent 节点之间执行取消检查和进度发布。
     */
    const result = await this.graph.invoke({
      company: run.company,
      focus: run.focus,
      depth: run.depth,
    });
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
          evidenceCandidates: result.evidenceCandidates,
          publishedReport: result.publishedReport,
          qualityWarning: result.qualityWarning,
          visitedNodes: result.visitedNodes,
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
