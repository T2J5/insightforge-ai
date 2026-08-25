/**
 * 调用 Tavily，并把厂商返回值转换成项目统一结构
 */
import { tavily, type TavilyClient } from "@tavily/core";
import { z } from "zod";
import {
  WebSearchHitSchema,
  WebSearchInputSchema,
  type WebSearchHit,
  type WebSearchInput,
  type WebSearchPort,
} from "./web-search";

/**
 * 只声明当前适配器实际使用的 Tavily 能力。
 *
 * 测试时可以传入只有 search 方法的 Fake Client，
 * 不需要真的请求 Tavily。
 */
export type TavilySearchClient = Pick<TavilyClient, "search">;

/**
 * Tavily 返回的单条原始搜索结果。
 *
 * 外部 API 的响应不能只相信 TypeScript 类型，
 * 所以仍然使用 Zod 做运行时校验。
 */
const TavilyRawSearchResultSchema = z
  .object({
    title: z.string(),
    url: z.url(),
    content: z.string(),
    score: z.number(),
  })
  .passthrough();
/**
 * 这里只校验当前项目真正需要的 results 字段。
 *
 * requestId、responseTime、images 等字段暂时不进入领域模型。
 */
const TavilyRawSearchResponseSchema = z
  .object({
    results: z.array(z.unknown()),
  })
  .passthrough();
/**
 * Tavily Web Search 适配器。
 *
 * 职责：
 *
 * 1. 把项目的 WebSearchInput 转换成 Tavily 参数；
 * 2. 调用 Tavily；
 * 3. 校验外部响应；
 * 4. 转换成项目统一的 WebSearchHit。
 */
export class TavilyWebSearch implements WebSearchPort {
  constructor(private readonly client: TavilySearchClient) {}

  async search(untrustedInput: WebSearchInput): Promise<WebSearchHit[]> {
    const input = WebSearchInputSchema.parse(untrustedInput);
    const response = await this.client.search(input.query, {
      searchDepth: input.searchDepth,
      topic: "general",
      maxResults: input.maxResults,
      /**
       * 目前只使用搜索结果，不采用 Tavily 自动生成的答案。
       *
       * 最终结论应由我们自己的 writer 根据来源生成。
       */
      includeAnswer: false,
      includeImages: false,
      /**
       * 当前阶段只需要搜索摘要。
       *
       * 后续 Evidence 阶段再单独抓取网页全文。
       */
      includeRawContent: false,
      /**
       * 禁止 Tavily 自动把 basic 升级为 advanced，
       * 避免不可预测的 Credit 消耗。
       */
      autoParameters: false,
      /**
       * 请求返回 Credit 用量。
       *
       * 本阶段暂不保存，后续观测任务再接入 State。
       */
      includeUsage: true,
    });
    const parsedResponse = TavilyRawSearchResponseSchema.parse(response);
    const hits: WebSearchHit[] = [];
    for (const untrustedResult of parsedResponse.results) {
      const parsedResult =
        TavilyRawSearchResultSchema.safeParse(untrustedResult);
      /**
       * 单条异常结果不应该导致其他有效结果全部丢失。
       */
      if (!parsedResult.success) {
        console.warn(
          "Tavily search result validation failed:",
          parsedResult.error.format(),
        );
        continue;
      }
      const result = parsedResult.data;
      const candidate = WebSearchHitSchema.safeParse({
        title: result.title.trim().slice(0, 500),
        url: result.url.trim(),
        /**
         * 控制单条片段长度，避免 5 条搜索结果就把
         * writer 的上下文窗口塞满。
         */
        snippet: result.content.trim().slice(0, 1_200),
        score: result.score,
      });
      /**
       * 空标题、空内容、非法 URL、非法 score
       * 都会在这里被过滤。
       */
      if (candidate.success) {
        hits.push(candidate.data);
      }
    }
    return hits.slice(0, input.maxResults);
  }
}

/**
 * 创建使用真实 Tavily API 的 WebSearchPort。
 *
 * Factory 负责创建厂商 SDK Client；
 * TavilyWebSearch 类本身只负责协议适配。
 */
export const createTavilyWebSearch = (
  untrustedApiKey: string,
): TavilyWebSearch => {
  const apiKey = untrustedApiKey.trim();
  if (apiKey.length === 0) {
    throw new Error("TAVILY_API_KEY_REQUIRED");
  }
  return new TavilyWebSearch(tavily({ apiKey }));
};
