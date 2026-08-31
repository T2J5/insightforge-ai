import { z } from "zod";
import { ResearchDepthSchema, ResearchFocusSchema } from "@insightforge/domain";

/**
 * 调研工具接收的输入。
 *
 * researcher 会针对 planner 生成的每一个问题，
 * 分别调用一次 ResearchTool。
 */
export const ResearchToolInputSchema = z
  .object({
    company: z.string().trim().min(2).max(120),
    focus: ResearchFocusSchema,
    depth: ResearchDepthSchema,
    questionId: z.string().trim().min(1).max(50),
    question: z.string().trim().min(1).max(500),
    timeoutMs: z.int().positive().optional(),
  })
  .strict();

export type ResearchToolInput = z.infer<typeof ResearchToolInputSchema>;

/**
 * 工具返回的一条来源。
 *
 * 目前它还不是最终 Evidence：
 *
 * - snippet 不保证是经过验证的原文引文；
 * - 没有 contentHash；
 * - 没有置信度；
 * - 没有存入 EvidenceRepository。
 *
 * Task 5 再把工具结果转换成标准 Evidence。
 */
export const ResearchSourceSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    url: z.url(),
    snippet: z.string().trim().min(1).max(4_000),
    publisher: z.string().trim().min(1).max(300).nullable().optional(),
    publishedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    retrievedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export type ResearchSource = z.infer<typeof ResearchSourceSchema>;

/**
 * 一个调研问题对应的调研结果。
 *
 * summary：
 * 工具根据来源整理出的阶段性结论。
 *
 * sources：
 * 支持该结论的原始搜索结果或资料。
 */
export const ResearchFindingSchema = z
  .object({
    questionId: z.string().trim().min(1).max(50),
    summary: z.string().trim().min(1).max(10_000),
    sources: z.array(ResearchSourceSchema).min(1).max(10),
  })
  .strict();

export type ResearchFinding = z.infer<typeof ResearchFindingSchema>;

/**
 * Agent 使用的调研工具端口。
 *
 * Agent 只依赖这个接口，不直接依赖搜索服务 SDK。
 *
 * 后续可以有不同实现：
 *
 * - FakeResearchTool；
 * - TavilyResearchTool；
 * - BraveResearchTool；
 * - UploadedDocumentResearchTool。
 */
export interface ResearchTool {
  research: (input: ResearchToolInput) => Promise<ResearchFinding>;
}
