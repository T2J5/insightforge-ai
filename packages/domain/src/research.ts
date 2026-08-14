import { z } from "zod";
/**
 * 负责定义：
调研方向；
调研深度；
任务状态；
创建调研任务的输入；
已保存的调研任务；
工作流检查点。
*/

/**
 * 调研关注方向。
 *
 * comprehensive：综合分析
 * product：产品
 * technology：技术
 * business：商业模式
 * competition：竞争格局
 */
export const ResearchFocusSchema = z.enum([
  "comprehensive",
  "product",
  "technology",
  "business",
  "competition",
]);

export type ResearchFocus = z.infer<typeof ResearchFocusSchema>;

/**
 * 调研深度。
 *
 * quick：快速调研
 * deep：深度调研
 */
export const ResearchDepthSchema = z.enum(["quick", "deep"]);

export type ResearchDepth = z.infer<typeof ResearchDepthSchema>;

/**
 * 一次调研任务的生命周期状态。
 */
export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * 创建调研任务时需要的字段。
 *
 * id、status、用量和时间由服务端或数据库生成，
 * 因此不允许调用方传入。
 */
export const CreateResearchRunSchema = z.object({
  ownerId: z.string().trim().min(1).max(128),

  company: z.string().trim().min(2).max(120),

  focus: ResearchFocusSchema,

  depth: ResearchDepthSchema,
});

export type CreateResearchRun = z.infer<typeof CreateResearchRunSchema>;

/**
 * 已持久化的完整调研任务。
 *
 * 该结构主要用于Repository返回值和内部服务之间传递。
 */
export const ResearchRunSchema = z.object({
  id: z.uuid(),

  ownerId: z.string().trim().min(1).max(128),

  company: z.string().trim().min(2).max(120),

  focus: ResearchFocusSchema,

  depth: ResearchDepthSchema,

  status: RunStatusSchema,

  tokenUsage: z.int().nonnegative(),

  estimatedCostCny: z.number().nonnegative(),

  createdAt: z.date(),

  updatedAt: z.date(),
});

export type ResearchRun = z.infer<typeof ResearchRunSchema>;

/**
 * PostgreSQL JSONB支持的值。
 *
 * 使用递归Schema限制检查点状态必须可以安全序列化为JSON，
 * 避免把Date、函数、类实例等内容直接写入JSONB。
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  JsonValueSchema,
);

/**
 * 保存检查点时调用方提供的内容。
 *
 * runId作为Repository方法参数传入，不在这个输入中重复出现。
 */
export const RunCheckpointInputSchema = z.object({
  checkpointKey: z.string().trim().min(1).max(128),

  state: JsonObjectSchema,
});

export type RunCheckpointInput = z.infer<typeof RunCheckpointInputSchema>;

/**
 * 数据库中已持久化的完整检查点。
 */
export const RunCheckpointSchema = z.object({
  id: z.uuid(),

  runId: z.uuid(),

  checkpointKey: z.string().trim().min(1).max(128),

  state: JsonObjectSchema,

  createdAt: z.date(),

  updatedAt: z.date(),
});

export type RunCheckpoint = z.infer<typeof RunCheckpointSchema>;
