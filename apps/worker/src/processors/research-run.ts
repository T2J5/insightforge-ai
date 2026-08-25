import {
  ResearchRunJobSchema,
  type ResearchRun,
  type ResearchRunJob,
  type RunProgressEvent,
  type RunStatus,
} from "@insightforge/domain";
import type { PublishProgressInput } from "../progress-publisher";
import { UnrecoverableError } from "bullmq";

export interface ResearchRunStore {
  get(runId: string): Promise<ResearchRun | null>;

  transition(
    runId: string,
    expected: RunStatus,
    next: RunStatus,
  ): Promise<ResearchRun>;
}

export interface ResearchCancellationGuard {
  assertNotCancelled(runId: string): Promise<void>;
}

export interface ResearchProgressPublisher {
  publish(input: PublishProgressInput): Promise<RunProgressEvent>;
}

/**
 * Task 4 中的 LangGraph 工作流需要实现这个接口。
 *
 * Processor 不关心内部有哪些 Agent 节点，只负责启动工作流。
 */
export interface ResearchWorkflow {
  run(runId: string): Promise<void>;
}

const stoppedStatuses = new Set<RunStatus>([
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
]);

const isStatusConflict = (error: unknown): boolean =>
  error instanceof Error && error.message === "RUN_STATUS_CONFLICT";

export class ResearchRunProcessor {
  constructor(
    private readonly runs: ResearchRunStore,
    private readonly workflow: ResearchWorkflow,
    private readonly progress: ResearchProgressPublisher,
    private readonly cancellation: ResearchCancellationGuard,
  ) {}

  async process(input: ResearchRunJob): Promise<void> {
    const job = ResearchRunJobSchema.parse(input);
    const { runId } = job;

    /**
     * 在查询数据库和开始任何耗时任务以前检查取消信号。
     */
    await this.cancellation.assertNotCancelled(runId);

    const run = await this.runs.get(runId);
    /**
     * 队列中存在任务，但PostgreSQL中没有对应业务记录，
     * 重试无法自动修复，因此使用UnrecoverableError。
     */
    if (!run) {
      throw new UnrecoverableError(`ResearchRun ${runId} not found`);
    }
    /**
     * 已经进入停止状态的任务不能重新执行。
     *
     * 这让重复投递、Worker重启和过期Job具备幂等性。
     */
    if (stoppedStatuses.has(run.status)) return;

    if (run.status === "queued") {
      try {
        await this.runs.transition(runId, "queued", "running");
      } catch (error) {
        /**
         * 另一个Worker可能已经抢先把任务改成running。
         * 重新读取数据库，以数据库中的最新状态为准。
         */
        if (!isStatusConflict(error)) {
          throw error;
        }

        const latestRun = await this.runs.get(runId);
        if (!latestRun) {
          throw new UnrecoverableError(`ResearchRun ${runId} not found`);
        }

        if (stoppedStatuses.has(latestRun.status)) return;

        if (latestRun.status !== "running") {
          throw error;
        }
      }
    }

    /**
     * 状态转换后再次检查。
     *
     * 用户可能恰好在queued变成running期间发出取消请求。
     */
    await this.cancellation.assertNotCancelled(runId);

    await this.progress.publish({
      runId,
      type: "status",
      status: "running",
      stage: "starting",
      message: "调研任务已由Worker接收",
      progress: 5,
      data: {},
    });
    /**
     * Processor不捕获工作流异常。
     *
     * 普通Error继续交给BullMQ重试；
     * UnrecoverableError则立即停止重试。
     */
    await this.workflow.run(runId);
  }
}
