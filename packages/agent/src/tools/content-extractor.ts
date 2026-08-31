import { z } from "zod";

/**
 * 正文提取深度。
 *
 * basic：
 * 速度快、成本较低。
 *
 * advanced：
 * 能处理表格、动态页面等复杂内容，
 * 但速度和成本更高。
 */
export const ContentExtractionDepthSchema = z.enum(["basic", "advanced"]);
export type ContentExtractionDepth = z.infer<
  typeof ContentExtractionDepthSchema
>;

/**
 * 一次正文提取请求。
 *
 * urls：
 * 从 Web Search 得到的候选网页。
 *
 * query：
 * 当前调研问题。
 * 提取服务根据 query 返回网页中最相关的正文块。
 */
export const ContentExtractionInputSchema = z
  .object({
    urls: z.array(z.url()).min(1).max(5),
    query: z.string().trim().min(1).max(1_000),
    extractionDepth: ContentExtractionDepthSchema,
    timeoutMs: z.int().positive().optional(),
  })
  .strict();
export type ContentExtractionInput = z.infer<
  typeof ContentExtractionInputSchema
>;

/**
 * 从网页中提取出的标准化正文。
 *
 * title 允许为空：
 * 某些网页无法可靠提取标题，
 * WebResearchTool 会回退到搜索结果标题。
 */
export const ExtractedPageSchema = z
  .object({
    url: z.url(),
    title: z.string().trim().min(1).max(500).nullable(),
    publisher: z.string().trim().min(1).max(300).nullable().optional(),
    publishedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    fetchedAt: z.iso.datetime({ offset: true }).optional(),
    /**
     * 这里保存的是与 query 相关的 Markdown 正文块。
     *
     * 限制为 6000 字符，防止异常网页占满上下文。
     */
    content: z.string().trim().min(1).max(6_000),
  })
  .strict();
export type ExtractedPage = z.infer<typeof ExtractedPageSchema>;

/**
 * 网页正文提取端口。
 *
 * 上层不关心具体使用：
 *
 * - Tavily Extract；
 * - 自建网页抓取器；
 * - Browserless；
 * - Firecrawl；
 * - 测试 Fake。
 */
export interface ContentExtractorPort {
  extract(input: ContentExtractionInput): Promise<ExtractedPage[]>;
}
