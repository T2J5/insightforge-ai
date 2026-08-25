import { z } from "zod";
import { ResearchDepthSchema, ResearchFocusSchema } from "@insightforge/domain";
import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { ResearchFindingSchema } from "./tools/research-tool";
import { EvidenceCandidateSchema } from "./evidence-candidate";
import {
  ReportCitationIssueSchema,
  ReportEvidenceIdsSchema,
} from "./report-citation";

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
    id: z.string().trim().min(1).max(50),
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

/**
 * 报告中的一个章节。
 *
 */
export const ReportSectionSchema = z
  .object({
    heading: z.string().trim().min(1).max(200),
    markdown: z.string().trim().min(1).max(20_000),
    evidenceIds: ReportEvidenceIdsSchema,
  })
  .strict();

export type ReportSection = z.infer<typeof ReportSectionSchema>;

/**
 * writer 节点的结构化输出。
 */
export const ReportDraftSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    executiveSummary: z.string().trim().min(1).max(4_000),
    executiveSummaryEvidenceIds: ReportEvidenceIdsSchema,
    sections: z.array(ReportSectionSchema).min(1).max(12),
  })
  .strict();

export type ReportDraft = z.infer<typeof ReportDraftSchema>;

/**
 * reviewer 节点的结构化输出。
 *
 * passed：
 * 是否通过评审。
 *
 * score：
 * 0～100 的报告质量评分。
 *
 * issues：
 * writer 修订报告时需要解决的问题。
 */
export const ReviewResultSchema = z
  .object({
    passed: z.boolean(),
    score: z.int().min(0).max(100),
    issues: z.array(z.string().trim().min(1).max(1_000)).max(20),
  })
  .strict();

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

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
 * LangGraph 工作流的共享状态。
 *
 * 每个节点都读取这个 State，
 * 然后只返回自己产生的局部更新。
 */
export const ResearchAgentState = new StateSchema({
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
   * citationValidator 发现的引用问题。
   *
   * writer 完成修订后会清空，
   * citationValidator 会重新计算。
   */
  citationIssues: z
    .array(ReportCitationIssueSchema)
    .max(50)
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
   * 引用格式修订次数。
   *
   * 它和 reviewer 内容修订次数分开累计。
   */
  citationRevisionCount: new ReducedValue(z.int().nonnegative().default(0), {
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
