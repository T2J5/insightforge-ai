import { z } from "zod";

/**
 * 报告内容的论断类型。
 *
 * fact：可被外部来源验证的事实，发布前必须引用有效证据。
 * inference：基于事实作出的分析或推断，允许没有直接引文，但应清楚表达为判断。
 * summary：对本报告已有内容的归纳，不强制重复引用。
 */
export const ReportClaimTypeSchema = z.enum(["fact", "inference", "summary"]);

export type ReportClaimType = z.infer<typeof ReportClaimTypeSchema>;

/**
 * 报告正文的最小可审核单位。
 *
 * 不直接在 Markdown 中嵌入脚注，而是保存 Evidence 的 UUID。
 * 这样可以先做权限、归属和完整性校验，再在展示层生成脚注。
 */
export const ReportContentBlockSchema = z
  .object({
    markdown: z.string().trim().min(1).max(20_000),
    claimType: ReportClaimTypeSchema,
    citationIds: z.array(z.uuid()).max(50),
  })
  .strict();

export type ReportContentBlock = z.infer<typeof ReportContentBlockSchema>;

/**
 * 当前企业调研报告必须覆盖的章节。
 * 固定 key 便于程序检查章节完整性；heading 仍可由 Writer 生成中文标题。
 */
export const RequiredReportSectionKeySchema = z.enum([
  "company_overview",
  "products_business_model",
  "market_competition",
  "technology_innovation",
  "recent_events",
  "strengths_risks",
  "conclusion",
]);

export const REQUIRED_REPORT_SECTION_KEYS =
  RequiredReportSectionKeySchema.options;

export type RequiredReportSectionKey = z.infer<
  typeof RequiredReportSectionKeySchema
>;

/**
 * unresolved_issues 不是必需章节，只在一次修订后仍未通过时由 Publisher 追加。
 */
export const ReportSectionKeySchema = z.union([
  RequiredReportSectionKeySchema,
  z.literal("unresolved_issues"),
]);

export type ReportSectionKey = z.infer<typeof ReportSectionKeySchema>;

export const CitedReportSectionSchema = z
  .object({
    key: ReportSectionKeySchema,
    heading: z.string().trim().min(1).max(200),
    blocks: z.array(ReportContentBlockSchema).min(1).max(100),
  })
  .strict();

export type CitedReportSection = z.infer<typeof CitedReportSectionSchema>;

/** Writer 输出、Reviewer 审核、Publisher 持久化时共享的报告结构。 */
export const CitedReportDraftSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    executiveSummary: z.array(ReportContentBlockSchema).min(1).max(20),
    sections: z.array(CitedReportSectionSchema).min(1).max(20),
  })
  .strict();

export type CitedReportDraft = z.infer<typeof CitedReportDraftSchema>;

export const ReportReviewIssueSeveritySchema = z.enum([
  "warning",
  "error",
  "critical",
]);

export const ReportReviewIssueSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    severity: ReportReviewIssueSeveritySchema,
    location: z.string().trim().min(1).max(500),
    message: z.string().trim().min(1).max(2_000),
    citationId: z.uuid().optional(),
  })
  .strict();

export type ReportReviewIssue = z.infer<typeof ReportReviewIssueSchema>;

/** Reviewer 的结构化结论，避免只返回无法由程序判断的自然语言。 */
export const StructuredReportReviewSchema = z
  .object({
    passed: z.boolean(),
    score: z.number().min(0).max(100),
    sectionCompleteness: z.number().min(0).max(1),
    citationCoverage: z.number().min(0).max(1),
    citationSupport: z.number().min(0).max(1),
    conflictHandling: z.number().min(0).max(1),
    issues: z.array(ReportReviewIssueSchema).max(200),
  })
  .strict();

export type StructuredReportReview = z.infer<
  typeof StructuredReportReviewSchema
>;
