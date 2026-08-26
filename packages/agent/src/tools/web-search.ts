/**
 * 定义与厂商无关的搜索输入、搜索结果和 WebSearchPort
 */
import { z } from "zod";

/**
 * 搜索深度。
 *
 * basic：
 * 搜索速度快、成本低，适合 quick 调研。
 *
 * advanced：
 * 返回更相关的内容片段，适合 deep 调研。
 */
export const WebSearchDepthSchema = z.enum(["basic", "advanced"]);
export type WebSearchDepth = z.infer<typeof WebSearchDepthSchema>;
/**
 * 一次 Web Search 的输入。
 *
 * 这是项目自己的搜索协议，不依赖 Tavily、Brave 等具体厂商。
 */
export const WebSearchInputSchema = z
  .object({
    /**
     * 搜索查询。
     *
     * 由 planner 根据问题生成。
     */
    query: z.string().trim().min(1).max(1_000),
    /**
     * 搜索深度。
     *
     * basic：
     * 搜索速度快、成本低，适合 quick 调研。
     *
     * advanced：
     * 返回更相关的内容片段，适合 deep 调研。
     */
    searchDepth: WebSearchDepthSchema,
    /**
     * 搜索结果数量。
     *
     * 1-10。
     */
    maxResults: z.int().min(1).max(10),
    timeoutMs: z.int().positive().optional(),
  })
  .strict();
export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

/**
 * 统一后的单条搜索结果。
 *
 * title：
 * 页面标题。
 *
 * url：
 * 原始网页地址。
 *
 * snippet：
 * 搜索服务返回的相关内容片段。
 *
 * score：
 * 搜索服务给出的相关性分数。
 */
export const WebSearchHitSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    url: z.url(),
    snippet: z.string().trim().min(1).max(1_200),
    score: z.number().finite().min(0).max(1),
  })
  .strict();
export type WebSearchHit = z.infer<typeof WebSearchHitSchema>;

/**
 * Web Search 端口。
 *
 * Agent 的 ResearchTool 只依赖这个接口，
 * 不直接依赖 Tavily SDK。
 *
 * 后续可以继续实现：
 *
 * - BraveWebSearch；
 * - GoogleWebSearch；
 * - FakeWebSearch；
 * - CachedWebSearch。
 */
export interface WebSearchPort {
  search(input: WebSearchInput): Promise<WebSearchHit[]>;
}
