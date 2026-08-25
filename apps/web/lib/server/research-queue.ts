import type { RESEARCH_RUN_JOB, ResearchRunJob } from "@insightforge/domain";
import { RESEARCH_RUN_QUEUE } from "@insightforge/domain";

import { Queue } from "bullmq";
import { type JobsOptions } from "bullmq";
import type IORedis from "ioredis";
import { getProducerRedis } from "./redis";

/**
 * 调研队列默认任务配置。
 *
 * 导出该常量便于测试、日志排查和后续运维配置检查。
 * 与 BullMQ 的任务重试与清理策略直接相关。
 */
export const RESEARCH_RUN_DEFAULT_JOB_OPTIONS = {
  // 任务失败后最多重试 3 次，合计最多执行 4 次（首次执行 + 3 次重试）。
  attempts: 4,

  backoff: {
    // 使用指数退避，避免瞬时大量重试压垮下游服务。
    type: "exponential",
    // 初始退避间隔为 2 秒，之后会按指数增长。
    delay: 2_000,
    // 加入 20% 抖动，减少多个 worker 同时重试造成的拥堵。
    jitter: 0.2,
  },
  removeOnComplete: {
    // 成功任务保留 24 小时，避免 Redis 内存无限增长。
    age: 24 * 60 * 60, // 1 day
    // 最多保留 1000 条成功任务，超出后按旧数据淘汰。
    count: 1_000,
  },

  removeOnFail: {
    // 失败任务保留 7 天，便于排查故障和追踪重试行为。
    age: 7 * 24 * 60 * 60, // 7 days
    // 最多保留 5000 条失败任务，避免异常积压占用大量 Redis 空间。
    count: 5_000,
  },
} satisfies JobsOptions;

/**
 * BullMQ 队列的强类型定义。
 *
 * - JobData: 任务消息体，必须符合 ResearchRunJob 结构。
 * - Result: 任务执行成功后的返回值，当前调研任务没有返回值，写为 void。
 * - Name: 队列中任务名的字面量类型，约束为 RESEARCH_RUN_JOB。
 */
export type ResearchQueue = Queue<
  ResearchRunJob,
  void,
  typeof RESEARCH_RUN_JOB
>;

/**
 * 创建独立的 BullMQ 调研队列。
 *
 * 测试可以传入唯一 queueName，避免不同测试互相污染。
 */
export const createResearchQueue = (
  connection: IORedis,
  queueName: string = RESEARCH_RUN_QUEUE,
): ResearchQueue => {
  const normalizedQueueName = queueName.trim();

  if (normalizedQueueName.length === 0) {
    throw new Error("RESEARCH_QUEUE_NAME_REQUIRED");
  }

  return new Queue<ResearchRunJob, void, typeof RESEARCH_RUN_JOB>(
    normalizedQueueName,
    {
      connection,
      defaultJobOptions: RESEARCH_RUN_DEFAULT_JOB_OPTIONS,
    },
  );
};

/**
 * 挂载到 globalThis，避免 Next.js 开发热更新重复创建 Queue。
 */
type QueueGlobal = typeof globalThis & {
  __insightforgeResearchQueue?: ResearchQueue;
};
const queueGlobal = globalThis as QueueGlobal;

/**
 * 获取 Web 进程共享的生产队列。
 */
export const getResearchQueue = (): ResearchQueue => {
  const cached = queueGlobal.__insightforgeResearchQueue;

  if (cached) {
    return cached;
  }

  const queue = createResearchQueue(getProducerRedis());
  queueGlobal.__insightforgeResearchQueue = queue;
  return queue;
};
