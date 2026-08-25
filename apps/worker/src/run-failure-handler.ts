import {
  ResearchRunJobSchema,
  type ResearchRun,
  type RunProgressEvent,
  type RunStatus,
} from "@insightforge/domain";
import { UnrecoverableError } from "bullmq";

import type { PublishProgressInput } from "./progress-publisher";

export interface FailedResearchJob {
  data: unknown;
  attemptsMade: number;
  opts: {
    attempts?: number;
  };
}

export interface FailedRunStore {
  get(runId: string): Promise<ResearchRun | null>;

  transition(
    runId: string,
    expected: RunStatus,
    next: RunStatus,
  ): Promise<ResearchRun>;
}
export interface FailedRunProgressPublisher {
  publish(input: PublishProgressInput): Promise<RunProgressEvent>;
}

const isStatusConflict = (error: unknown): boolean =>
  error instanceof Error && error.message === "RUN_STATUS_CONFLICT";

/**
 * 只在任务不再重试时，把业务状态更新为 failed。
 */
export class ResearchRunFailureHandler {
  constructor(
    private readonly runs: FailedRunStore,
    private readonly progress: FailedRunProgressPublisher,
  ) {}

  async handle(
    job: FailedResearchJob | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) {
      return;
    }
    const parsedJob = ResearchRunJobSchema.safeParse(job.data);
    if (!parsedJob.success) {
      return;
    }
    const maximumAttempts = job.opts.attempts ?? 1;
    const unrecoverable =
      error instanceof UnrecoverableError ||
      error.name === "UnrecoverableError";
    const attemptsExhausted = job.attemptsMade >= maximumAttempts;
    /**
     * BullMQ 还会继续重试时，
     * 数据库必须保持 running。
     */
    if (!unrecoverable && !attemptsExhausted) {
      return;
    }
    const { runId } = parsedJob.data;
    const run = await this.runs.get(runId);
    if (!run || run.status !== "running") {
      return;
    }
    try {
      await this.runs.transition(runId, "running", "failed");
    } catch (transitionError) {
      if (isStatusConflict(transitionError)) {
        return;
      }
      throw transitionError;
    }
    await this.progress.publish({
      runId,
      type: "status",
      status: "failed",
      stage: "failed",
      message: "调研任务执行失败，请稍后重试",
      progress: 100,
      data: {
        code: "RESEARCH_RUN_FAILED",
      },
    });
  }
}
