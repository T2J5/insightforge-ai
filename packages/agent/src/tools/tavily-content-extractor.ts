import { tavily, type TavilyClient } from "@tavily/core";
import { z } from "zod";
import {
  ContentExtractionInputSchema,
  ExtractedPageSchema,
  type ContentExtractionInput,
  type ContentExtractorPort,
  type ExtractedPage,
} from "./content-extractor";

export type TavilyExtractClient = Pick<TavilyClient, "extract">;

const TavilyRawExtractResultSchema = z
  .object({
    url: z.string(),
    title: z.string().nullable(),
    rawContent: z.string(),
  })
  .passthrough();

const TavilyRawExtractResponseSchema = z
  .object({
    results: z.array(z.unknown()),
  })
  .passthrough();
export class TavilyContentExtractor implements ContentExtractorPort {
  constructor(private readonly client: TavilyExtractClient) {}

  async extract(
    untrustedInput: ContentExtractionInput,
  ): Promise<ExtractedPage[]> {
    // 解析校验参数
    const input = ContentExtractionInputSchema.parse(untrustedInput);
    // urls 可能相同，去重保留10个
    const urls = [...new Set(input.urls)].slice(0, 5);
    const response = await this.client.extract(urls, {
      extractDepth: input.extractionDepth,
      format: "markdown",
      includeImages: false,
      includeFavicon: false,
      includeUsage: true,
      query: input.query,
      /**
       * quick/basic 返回较少内容块；
       * deep/advanced 返回更多内容块。
       *
       * Tavily 规定范围为 1～5。
       */
      chunksPerSource: input.extractionDepth === "basic" ? 2 : 3,
    });
    /**
     * Tavily 的响应可能是：
     *
      {
        results: [
          // 成功提取的页面
        ],
        failedResults: [
          // 失败的页面
        ]
      }
     */

    // 校验返回结果
    const parsedResponse = TavilyRawExtractResponseSchema.parse(response);
    const pages: ExtractedPage[] = []; // 存储提取的页面结果
    const seenUrls = new Set<string>(); // 存储已处理的 URL，避免重复

    for (const untrustedResult of parsedResponse.results) {
      const parsedResult =
        TavilyRawExtractResultSchema.safeParse(untrustedResult);
      // 如果解析失败，跳过该结果
      if (!parsedResult.success) {
        continue;
      }
      const result = parsedResult.data;
      const url = result.url.trim();
      // 如果 URL 已经处理过，跳过该结果
      if (seenUrls.has(url)) {
        continue;
      }
      const normalizedTitle = result.title?.trim().slice(0, 500) || null; // 标题可能为空，限制长度为 500 字符
      // 截取内容的前 6000 个字符，避免过长,规范化结果
      const candidate = ExtractedPageSchema.safeParse({
        url,
        title: normalizedTitle,
        content: result.rawContent.trim().slice(0, 6_000),
      });

      if (!candidate.success) {
        continue;
      }
      // 将有效的结果加入到 pages 中，并记录已处理的 URL
      seenUrls.add(candidate.data.url);
      pages.push(candidate.data);

      // 结束循环条件：如果已经收集到的页面数量大于等于输入的 URL 数量，则结束循环
      if (pages.length >= urls.length) {
        break;
      }
    }
    return pages;
  }
}

export const createTavilyContentExtractor = (
  untrustedApiKey: string,
): TavilyContentExtractor => {
  const apiKey = untrustedApiKey.trim();
  if (apiKey.length === 0) {
    throw new Error("TAVILY_API_KEY_REQUIRED");
  }
  return new TavilyContentExtractor(
    tavily({
      apiKey,
    }),
  );
};
