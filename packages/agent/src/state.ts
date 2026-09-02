import { z } from "zod";
import {
  CitedReportDraftSchema,
  EvidenceSchema,
  ReportReviewIssueSchema,
  ResearchDepthSchema,
  ResearchFocusSchema,
  StructuredReportReviewSchema,
  type CitedReportDraft,
  type StructuredReportReview,
} from "@insightforge/domain";
import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { ResearchFindingSchema } from "./tools/research-tool";
import { EvidenceCandidateSchema } from "./evidence-candidate";

/**
 * Agent 调研计划中的问题 ID。
 *
 * 后续 findings、completedQuestionIds 和证据都通过该 ID
 * 关联到 planner 生成的问题。
 */
export const ResearchQuestionIdSchema = z.string().trim().min(1).max(50);
/**
 * planner 生成的单个调研问题。
 *
 * id：
 * 用于后续匹配问题、搜索结果和证据。
 *
 * question：
 * 真正需要调查的问题。
 *
 * rationale：
 * 为什么这个问题值得调查。
 */
export const ResearchQuestionSchema = z
  .object({
    id: ResearchQuestionIdSchema,
    question: z.string().trim().min(1).max(500),
    rationale: z.string().trim().min(1).max(1_000),
  })
  .strict();

export type ResearchQuestion = z.infer<typeof ResearchQuestionSchema>;

/**
 * planner 节点的结构化输出。
 *
 * 这不是自由文本，而是经过 Zod 验证的调研计划。
 */
export const ResearchPlanSchema = z
  .object({
    objective: z.string().trim().min(1).max(1_000),

    questions: z.array(ResearchQuestionSchema).min(1).max(8),
  })
  .strict();

export type ResearchPlan = z.infer<typeof ResearchPlanSchema>;

/** 保留原导出名，避免调用方关心 Schema 实际定义在哪个领域文件。 */
export const ReportDraftSchema = CitedReportDraftSchema;
export type ReportDraft = CitedReportDraft;

export const ReviewResultSchema = StructuredReportReviewSchema;
export type ReviewResult = StructuredReportReview;

/**
 * Agent 工作流自身的执行阶段。
 *
 * 注意它和 research_runs.status 不完全相同：
 *
 * AgentWorkflowStatus：
 * 描述 Agent 图内部执行到了哪个阶段。
 *
 * RunStatus：
 * 描述整个异步业务任务的生命周期。
 */
export const AgentWorkflowStatusSchema = z.enum([
  "planning",
  "researching",
  "extracting_evidence",
  "validating_citations",
  "writing",
  "reviewing",
  "completed",
]);

export type AgentWorkflowStatus = z.infer<typeof AgentWorkflowStatusSchema>;

/**
 * Checkpoint 中必须保持稳定的业务身份字段。
 *
 * Worker 恢复前会把这些字段与 research_runs 记录比较，
 * 防止损坏或串线的 Checkpoint 触发错误的外部调用。
 */
export const ResearchAgentCheckpointIdentitySchema = z.object({
  runId: z.uuid(),
  reportId: z.uuid(),
  /**
   * ownerId 不会提供给模型。
   *
   * 它只用于：
   * 1. 保存 Evidence；
   * 2. 校验证据是否属于当前用户；
   * 3. 防止恢复错误用户的 Checkpoint。
   */
  ownerId: z.string().trim().min(1).max(128),
  company: z.string().trim().min(2).max(120),
  focus: ResearchFocusSchema,
  depth: ResearchDepthSchema,
  startedAt: z.iso.datetime({ offset: true }),
  deadlineAt: z.iso.datetime({ offset: true }),
});

export type ResearchAgentCheckpointIdentity = z.infer<
  typeof ResearchAgentCheckpointIdentitySchema
>;
/**
 * Graph 完成后，Worker 真正需要保存和提交的结果。
 *
 * 没有使用 strict()：
 * LangGraph 完整 State 还包含 plan、findings、draft、review 等字段；
 * 这里解析后只保留 Worker 需要的最终字段。
 */
export const ResearchAgentCompletedResultSchema = z.object({
  runId: z.uuid(),
  reportId: z.uuid(),
  status: z.literal("completed"),
  evidenceCandidates: z.array(EvidenceCandidateSchema).max(12),
  evidence: z.array(EvidenceSchema).max(50),
  /**
   * completed 状态必须存在已发布报告，
   * 因此这里不是 nullable。
   */
  publishedReport: ReportDraftSchema,
  qualityWarning: z.string().trim().min(1).max(2_000).nullable(),
  visitedNodes: z.array(z.string().trim().min(1)).max(100),
  searchCount: z.int().nonnegative(),
  completedQuestionIds: z.array(ResearchQuestionIdSchema).max(8),
  startedAt: z.iso.datetime({ offset: true }),
  deadlineAt: z.iso.datetime({ offset: true }),
  tokenUsage: z.int().nonnegative(),
  estimatedCostCny: z.number().finite().nonnegative(),
});

export type ResearchAgentCompletedResult = z.infer<
  typeof ResearchAgentCompletedResultSchema
>;
/**
 * LangGraph 工作流的共享状态。
 *
 * 每个节点都读取这个 State，
 * 然后只返回自己产生的局部更新。
 */
export const ResearchAgentState = new StateSchema({
  /**
   * 对应 PostgreSQL research_runs.id。
   *
   * Agent 检查点恢复时，必须知道状态属于哪个业务任务。
   */
  runId: z.uuid(),
  /** 当前实现一个 Run 对应一个 Report，Worker 使用 runId 作为稳定 reportId。 */
  reportId: z.uuid(),
  /**
   * 当前调研任务所属用户。
   *
   * 该字段属于服务端安全上下文，不能进入模型 Prompt。
   */
  ownerId: z.string().trim().min(1).max(128),
  /**
   * Worker 首次把任务转换为 running 的时间。
   *
   * 使用 ISO 字符串而不是 Date，
   * 保证状态可以安全写入 PostgreSQL JSONB。
   */
  startedAt: z.iso.datetime({ offset: true }), // offset:true 保证时区信息不会丢失
  /**
   * 整个 Agent 工作流的最晚完成时间。
   *
   * Task 4.2 只保存该字段；
   * Task 4.4 才会在每个节点执行前检查是否超时。
   */
  deadlineAt: z.iso.datetime({ offset: true }),
  company: z.string().trim().min(2).max(120),
  focus: ResearchFocusSchema,
  depth: ResearchDepthSchema,

  /**
   * 节点输出字段。
   * default(null) 是调用graph.invoke时不需要手动提供所有未产生的中间状态
   */
  plan: ResearchPlanSchema.nullable().default(null),
  /**
   * researcher 调用工具后产生的调研发现。
   *
   * 当前 researcher 一次返回全部 findings，
   * 因此使用普通数组字段，不需要 ReducedValue。
   */
  findings: z
    .array(ResearchFindingSchema)
    .max(8)
    .default(() => []),
  /**
   * 已成功执行的调研搜索次数。
   *
   * 每个 researcher 调用返回本次新增的搜索次数，
   * Reducer 将不同节点或恢复执行产生的增量累加。
   */
  searchCount: new ReducedValue(z.int().nonnegative().default(0), {
    inputSchema: z.int().nonnegative(),
    reducer: (cur, inc) => cur + inc,
  }),
  /**
   * 已经成功获得调研结果的问题 ID。
   *
   * 使用追加并去重的 Reducer：
   * - Worker 重试时重复完成同一问题不会产生重复 ID；
   * - 后续可以根据该字段跳过已经完成的问题。
   */
  completedQuestionIds: new ReducedValue(
    z
      .array(ResearchQuestionIdSchema)
      .max(8)
      .default(() => []),
    {
      inputSchema: z.array(ResearchQuestionIdSchema).max(8),
      reducer: (cur, incoming) => [...new Set([...cur, ...incoming])],
    },
  ),
  /**
   * 经过 URL 和逐字引用校验的候选证据。
   *
   * 最多 6 个问题，
   * 每个问题最多 2 条证据。
   */
  evidenceCandidates: z
    .array(EvidenceCandidateSchema)
    .max(12)
    .default(() => []),
  /**
   * 已完成标准化并写入 PostgreSQL 的正式证据。
   *
   * evidenceCandidates 是模型提取阶段的中间结果；
   * evidence 才能被 Writer、Reviewer 和 Publisher 使用。
   *
   * 这里保存的 id 是数据库 Evidence UUID，
   * 不再是 E1、E2 这样的工作流临时 ID。
   */
  evidence: z
    .array(EvidenceSchema)
    .max(50)
    .default(() => []),
  /**
   * citationValidator 发现的引用问题。
   *
   * writer 完成修订后会清空，
   * citationValidator 会重新计算。
   */
  citationIssues: z
    .array(ReportReviewIssueSchema)
    .max(200)
    .default(() => []),
  draft: ReportDraftSchema.nullable().default(null),
  review: ReviewResultSchema.nullable().default(null),
  publishedReport: ReportDraftSchema.nullable().default(null),
  qualityWarning: z.string().trim().min(1).max(2_000).nullable().default(null),
  /**
   * ReducedValue 表示该字段不是简单覆盖，
   * 而是把每次节点返回的增量累加起来。
   *
   * writer 第一次写作返回 0；
   * 真正修订时返回 1。
   */
  revisionCount: new ReducedValue(z.int().nonnegative().default(0), {
    inputSchema: z.int().nonnegative(),
    reducer: (cur, inc) => cur + inc,
  }),
  /**
   * 节点每次只返回自己的名称：
   *
   * { visitedNodes: "planner" }
   *
   * Reducer 将其追加为：
   *
   * ["planner", "writer", "reviewer"]
   */
  visitedNodes: new ReducedValue(
    z.array(z.string()).default(() => []),
    {
      inputSchema: z.string().trim().min(1),
      reducer: (cur, nodeName) => [...cur, nodeName],
    },
  ),
  /**
   * 每个模型节点返回本次调用消耗的 Token，
   * Reducer 负责累加整个 Agent 的 Token。
   */
  tokenUsage: new ReducedValue(z.int().nonnegative().default(0), {
    inputSchema: z.int().nonnegative(),
    reducer: (cur, inc) => cur + inc,
  }),
  /**
   * 累计模型调用成本。
   */
  estimatedCostCny: new ReducedValue(z.number().nonnegative().default(0), {
    inputSchema: z.number().nonnegative(),
    reducer: (cur, inc) => cur + inc,
  }),
  status: AgentWorkflowStatusSchema.default("planning"),
});

/**
 * 完整 State 类型。
 *
 * 给节点、路由函数和外部调用方使用。
 */
export type ResearchAgentStateValue = typeof ResearchAgentState.State;

/**
 * 节点允许返回的局部更新类型。
 */
export type ResearchAgentStateUpdate = typeof ResearchAgentState.Update;
