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
  ResearchAgentCheckpointIdentitySchema,
  ResearchAgentCompletedResultSchema,
  type ResearchAgentCompletedResult,
  type ResearchBudgets,
} from "@insightforge/agent";

export interface ResearchAgentInvocationConfig {
  configurable: {
    /**
     * LangGraph 使用 thread_id 查找本次 Run 的持久化状态。
     */
    thread_id: string;
  };
  /**
   * sync 表示当前节点的 Checkpoint 成功提交后，
   * 才允许开始下一个节点。
   *
   * durability 是 LangGraph 调用配置，不属于 configurable。
   */
  durability: "sync";
}

export interface ResearchAgentInput {
  runId: string;
  company: string;
  focus: ResearchFocus;
  depth: ResearchDepth;
  startedAt: string;
  deadlineAt: string;
}

/**
 * Worker 只依赖 StateSnapshot 中恢复判断需要的字段，
 * 不耦合 LangGraph 的全部内部类型。
 */
export interface ResearchAgentStateSnapshot {
  readonly values: unknown;
  /** 下一步等待执行的节点名称。
   *
   * 非空：
   * Graph 尚未完成，可以使用 null 恢复。
   *
   * 空数组：
   * 没有待执行节点。
   */
  readonly next: readonly string[];
  /**
   * 不存在表示当前 thread_id 尚无 Checkpoint。
   */
  readonly createdAt?: string;
}

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

export type ResearchAgentResult = ResearchAgentCompletedResult;

export interface ResearchAgentRunner {
  /**
   * 返回 unknown 是有意的。
   *
   * Graph 输出可能来自 PostgreSQL Checkpoint，
   * 不能只依赖 TypeScript，必须经过 Zod 运行时校验。
   */
  invoke(
    input: ResearchAgentInput | null,
    config: ResearchAgentInvocationConfig,
  ): Promise<unknown>;
  getState(
    config: ResearchAgentInvocationConfig,
  ): Promise<ResearchAgentStateSnapshot>;
}

type PreparedResearchAgentExecution =
  | {
      mode: "fresh";
      input: ResearchAgentInput;
    }
  | {
      mode: "resume";
      input: null;
    }
  | {
      mode: "finalize";
      checkpointValues: unknown;
    };

/**
 * 确认 PostgreSQL Checkpoint 确实属于当前 ResearchRun。
 *
 * 只比较 runId 不够：
 * 同一个 runId 下损坏的 company、depth 或 deadline
 * 仍可能造成错误搜索和预算绕过。
 */
const assertCheckpointIdentity = (
  checkpointValues: unknown,
  expected: ResearchAgentInput,
): void => {
  const parsed =
    ResearchAgentCheckpointIdentitySchema.safeParse(checkpointValues);
  if (!parsed.success) {
    throw new UnrecoverableError(`AGENT_CHECKPOINT_INVALID`);
  }

  const actual = parsed.data;
  if (
    actual.runId !== expected.runId ||
    actual.company !== expected.company ||
    actual.focus !== expected.focus ||
    actual.depth !== expected.depth ||
    actual.startedAt !== expected.startedAt ||
    actual.deadlineAt !== expected.deadlineAt
  ) {
    throw new UnrecoverableError(`AGENT_CHECKPOINT_IDENTITY_CONFLICT`);
  }
};

// 增加恢复模式判断函数
const prepareResearchAgentExecution = (
  snapshot: ResearchAgentStateSnapshot,
  initialInput: ResearchAgentInput,
): PreparedResearchAgentExecution => {
  /**
   * createdAt 不存在：
   * 当前 thread_id 从未保存过 Checkpoint。
   */
  if (snapshot.createdAt === undefined) {
    return {
      mode: "fresh",
      input: initialInput,
    };
  }

  /**
   * 只要 Checkpoint 存在，就必须先验证业务身份。
   *
   * 不能先恢复节点再检查，否则错误 Checkpoint
   * 可能已经触发模型或搜索调用。
   */
  assertCheckpointIdentity(snapshot.values, initialInput);

  if (snapshot.next.length > 0) {
    return {
      mode: "resume",
      input: null,
    };
  }

  /**
   * next 为空且 Checkpoint 存在：
   * Graph 已经没有待执行节点。
   *
   * 常见场景是：
   * Graph 已完成，但 Worker 在更新 research_runs 前退出。
   */
  return {
    mode: "finalize",
    checkpointValues: snapshot.values,
  };
};

const parseCompletedAgentResult = (
  untrustedResult: unknown,
  source: "graph" | "checkpoint",
): ResearchAgentResult => {
  const parsed = ResearchAgentCompletedResultSchema.safeParse(untrustedResult);
  if (parsed.success) {
    return parsed.data;
  }

  /**
   * 已完成 Checkpoint 无法被解析时，
   * 重试不会自动修复数据库中的损坏状态。
   */
  if (source === "checkpoint") {
    throw new UnrecoverableError(`AGENT_CHECKPOINT_INVALID`);
  }
  throw new UnrecoverableError(`AGENT_WORKFLOW_NOT_COMPLETED`);
};

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

    const initialInput: ResearchAgentInput = {
      runId,
      company: run.company,
      focus: run.focus,
      depth: run.depth,
      startedAt: startedAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
    };

    const config: ResearchAgentInvocationConfig = {
      configurable: {
        thread_id: runId,
      },
      durability: "sync",
    };

    /**
     * 当前使用 invoke 获取最终状态。
     *
     * 后续任务会升级为 graph.stream，
     * 在每个 Agent 节点之间执行取消检查和进度发布。
     */
    let result: ResearchAgentResult;
    try {
      const snapshot = await this.graph.getState(config);
      const prepared = prepareResearchAgentExecution(snapshot, initialInput);
      /**
       * 先发布本次 Worker 执行的模式。
       *
       * 这不是 LangGraph 节点进度；
       * 它描述 Worker 是首次执行、恢复还是仅提交最终结果。
       */
      await this.progress.publish({
        runId,
        type: "progress",
        status: "running",
        stage: "planning",
        message:
          prepared.mode === "fresh"
            ? "Agent 开始规划企业调研任务"
            : prepared.mode === "resume"
              ? "Agent 从 PostgreSQL Checkpoint 恢复执行"
              : "Agent 使用已完成 Checkpoint 提交调研结果",
        progress: prepared.mode === "fresh" ? 10 : 15,
        data: {
          executionMode: prepared.mode,
          pendingNodes: [...snapshot.next],
        },
      });
      if (prepared.mode === "finalize") {
        result = parseCompletedAgentResult(
          prepared.checkpointValues,
          "checkpoint",
        );
      } else {
        const graphResult = await this.graph.invoke(prepared.input, config);
        result = parseCompletedAgentResult(graphResult, "graph");
      }
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
      throw new UnrecoverableError(`AGENT_RUN_ID_MISMATCH`);
    }
    await this.cancellation.assertNotCancelled(runId);

    /**
     * Task 3 先把 Agent 输出保存成检查点，
     * 防止 Worker 执行完成后报告只存在于内存。
     *
     * EvidenceRepository 和 ReportRepository 的正式写入
     * 留到后续持久化集成任务。
     */
    const checkpointState = JsonObjectSchema.parse({
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
    });
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
