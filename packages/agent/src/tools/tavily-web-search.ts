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
import {
  defaultSleep,
  readHttpStatusFromError,
  RetryableWebError,
  retryWebOperation,
  type Sleep,
} from "./web-resilience";

/**
 * 只声明当前适配器实际使用的 Tavily 能力。
 *
 * 测试时可以传入只有 search 方法的 Fake Client，
 * 不需要真的请求 Tavily。
 */
export type TavilySearchClient = Pick<TavilyClient, "search">;

export interface TavilyWebSearchOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: Sleep;
}
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
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: Sleep;
  constructor(
    private readonly client: TavilySearchClient,
    options: TavilyWebSearchOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async search(untrustedInput: WebSearchInput): Promise<WebSearchHit[]> {
    const input = WebSearchInputSchema.parse(untrustedInput);
    const timeoutMs = input.timeoutMs ?? 10_000;
    const deadlineAt = Date.now() + timeoutMs;
    const response = await retryWebOperation(
      async () => {
        try {
          const remainingTimeoutMs = Math.max(1, deadlineAt - Date.now());
          return await this.client.search(input.query, {
            searchDepth: input.searchDepth,
            topic: "general",
            maxResults: input.maxResults,
            ...(input.timeoutMs === undefined
              ? {}
              : {
                  timeout: Math.max(1, Math.ceil(remainingTimeoutMs / 1000)),
                }),
            includeAnswer: false,
            includeImages: false,
            includeRawContent: false,
            autoParameters: false,
            includeUsage: true,
          });
        } catch (error) {
          const status = readHttpStatusFromError(error);
          if (status === 429) {
            throw new RetryableWebError("SEARCH_RATE_LIMITED", {
              cause: error,
            });
          }
          if (
            status === 408 ||
            status === 500 ||
            status === 502 ||
            status === 503 ||
            status === 504 ||
            status === null
          ) {
            throw new RetryableWebError("SEARCH_UNAVAILABLE", { cause: error });
          }

          throw new Error("SEARCH_UNAVAILABLE", {
            cause: error,
          });
        }
      },
      {
        maxAttempts: this.maxAttempts,
        retryDelayMs: this.retryDelayMs,
        sleep: this.sleep,
        deadlineAt,
      },
    );
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
