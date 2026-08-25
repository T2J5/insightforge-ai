import {
  RESEARCH_RUN_JOB,
  RESEARCH_RUN_QUEUE,
  ResearchRunJobSchema,
  type ResearchRunJob,
} from "@insightforge/domain";
import { UnrecoverableError, Worker } from "bullmq";
import type IORedis from "ioredis";

export const DEFAULT_RESEARCH_WORKER_CONCURRENCY = 4;

export interface ResearchJobProcessor {
  process(input: ResearchRunJob): Promise<void>;
}

export interface CreateResearchWorkerOptions {
  queueName?: string;
  concurrency?: number;
  /**
   * 测试时可设为false，避免创建Worker后立即消费任务。
   */
  autorun?: boolean;
}

export type ResearchWorker = Worker<ResearchRunJob, void, string>;

export const createResearchWorker = (
  connection: IORedis,
  processor: ResearchJobProcessor,
  options: CreateResearchWorkerOptions = {},
): ResearchWorker => {
  const queueName =
    options.queueName === undefined
      ? RESEARCH_RUN_QUEUE
      : options.queueName.trim();
  if (queueName.length === 0) {
    throw new Error("RESEARCH_QUEUE_NAME_REQUIRED");
  }

  const concurrency =
    options.concurrency ?? DEFAULT_RESEARCH_WORKER_CONCURRENCY;

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("RESEARCH_WORKER_CONCURRENCY_INVALID");
  }

  return new Worker<ResearchRunJob, void, string>(
    queueName,
    async (job) => {
      /**
       * 队列中可能残留旧版本或错误名称的Job。
       * 这类错误重试无法修复，因此禁止BullMQ重试。
       */
      if (job.name !== RESEARCH_RUN_JOB) {
        throw new UnrecoverableError(`Unsupported research job: ${job.name}`);
      }
      /**
       * Job数据来自Redis，不能只信任TypeScript类型。
       */
      const parsed = ResearchRunJobSchema.safeParse(job.data);
      if (!parsed.success) {
        throw new UnrecoverableError("INVALID_RESEARCH_RUN_JOB");
      }
      await processor.process(parsed.data);
    },
    {
      connection,
      concurrency,
      autorun: options.autorun ?? true,
      /**
       * 同一个Job最多允许因Worker失联而恢复一次。
       * 普通业务重试次数仍由Queue的attempts控制。
       */
      maxStalledCount: 1,
    },
  );
};
