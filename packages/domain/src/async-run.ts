/**
 * ! API 创建调研任务时允许接收什么数据；
BullMQ Job 中保存什么数据；
Web 与 Worker 使用的队列名和任务名；
Redis/SSE 进度事件的数据格式。
*/
import { z } from "zod";
import {
  JsonObjectSchema,
  ResearchDepthSchema,
  ResearchFocusSchema,
  RunStatusSchema,
} from "./research";

export const RESEARCH_RUN_QUEUE = "research-runs";
export const RESEARCH_RUN_JOB = "research-run";

/**
 * POST /api/runs 的请求体。
 *
 * ownerId 不能由客户端提交，必须由服务端登录状态提供。
 */
export const CreateRunRequestSchema = z
  .object({
    company: z.string().trim().min(2).max(120),
    focus: ResearchFocusSchema,
    depth: ResearchDepthSchema,
    documentIds: z.array(z.uuid()).max(10).default([]),
  })
  .strict();

export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

/**
 * 写入 BullMQ 的最小消息。
 *
 * PostgreSQL 是权威数据源，Worker 使用 runId 重新加载任务。
 */
export const ResearchRunJobSchema = z
  .object({
    runId: z.string().uuid(),
  })
  .strict();

export type ResearchRunJob = z.infer<typeof ResearchRunJobSchema>;

export const RunProgressEventTypeSchema = z.enum([
  "status",
  "progress",
  "warning",
]);

export type RunProgressEventType = z.infer<typeof RunProgressEventTypeSchema>;

/**
 * Redis 和 SSE 之间传递的进度事件。
 */
export const RunProgressEventSchema = z
  .object({
    /**
     * 每个 Run 内单调递增的事件序号。
     * SSE 会把它写入 id 字段，用于断线重连后的事件回放。
     */
    id: z.int().positive(),
    runId: z.uuid(),
    type: RunProgressEventTypeSchema,
    status: RunStatusSchema,
    /**
     * 当前执行阶段，例如 queued、planning、searching、writing。
     */
    stage: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(500),
    progress: z.int().min(0).max(100),
    /**
     * 使用 ISO 8601 字符串，因为事件需要经过 Redis JSON 序列化。
     */
    occurredAt: z.iso.datetime({ offset: true }),
    /**
     * 为后续节点指标、错误代码等扩展信息预留。
     */
    data: JsonObjectSchema.default({}),
  })
  .strict();
export type RunProgressEvent = z.infer<typeof RunProgressEventSchema>;

//
export const RUN_EVENT_LOG_LIMIT = 200;
//
export const RUN_EVENT_TTL_SECONDS = 24 * 60 * 60; // 1 day

export const getRunEventRedisKeys = (runId: string) => {
  const job = ResearchRunJobSchema.parse({ runId });
  const prefix = `run:${job.runId}`;

  return {
    sequence: `${prefix}:event-sequence`,
    log: `${prefix}:event-log`,
    channel: `${prefix}:events`,
  };
};
