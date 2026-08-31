/**
 * 把 planner 的问题转换成搜索查询，再把搜索结果转换成 ResearchFinding
 */
import {
  ResearchFindingSchema,
  ResearchToolInputSchema,
  type ResearchFinding,
  type ResearchTool,
  type ResearchToolInput,
} from "./research-tool";
import { type WebSearchInput, type WebSearchPort } from "./web-search";
import {
  ExtractedPageSchema,
  type ContentExtractionInput,
  type ContentExtractorPort,
} from "./content-extractor";
import z from "zod";
import { canonicalizeWebUrl } from "./search-web";

/**
 * 使用 Web Search 完成调研问题的工具。
 *
 * Graph 调用的是 ResearchTool；
 * WebResearchTool 再调用底层 WebSearchPort。
 */
export class WebResearchTool implements ResearchTool {
  constructor(
    private readonly webSearch: WebSearchPort,
    private readonly contentExtractor: ContentExtractorPort,
    private readonly now: () => number = Date.now,
  ) {}

  async research(untrustedInput: ResearchToolInput): Promise<ResearchFinding> {
    const input = ResearchToolInputSchema.parse(untrustedInput);
    const operationStartedAt = this.now();
    /**
     * 计算当前调用还剩多少时间。
     */
    const getRemainingTimeoutMs = (): number | undefined => {
      if (input.timeoutMs === undefined) {
        return undefined;
      }

      const remaining = input.timeoutMs - (this.now() - operationStartedAt);

      if (remaining < 1) {
        throw new Error("RESEARCH_TOOL_TIMEOUT");
      }

      return Math.ceil(remaining);
    };

    /**
     * quick：
     * 使用 basic 搜索，每个问题最多取 3 条来源。
     *
     * deep：
     * 使用 advanced 搜索，每个问题最多取 5 条来源。
     */
    const searchInput: WebSearchInput = {
      query: `${input.company} ${input.question}`,
      searchDepth: input.depth === "quick" ? "basic" : "advanced",
      maxResults: input.depth === "quick" ? 3 : 5,
      ...(input.timeoutMs === undefined
        ? {}
        : {
            timeoutMs: getRemainingTimeoutMs(),
          }),
    };
    const hits = await this.webSearch.search(searchInput);
    /**
     * ResearchFindingSchema 要求至少有一条来源。
     *
     * 与其返回无法支持结论的空 Finding，
     * 不如让本次调研明确失败。
     */
    if (hits.length === 0) {
      throw new Error(`SEARCH_RESULTS_EMPTY`);
    }

    /**
     * 第二步：批量提取搜索结果正文。
     *
     * 一次传入全部 URL，
     * 不能在循环中一个 URL 调一次 API。
     */
    const extractionInput: ContentExtractionInput = {
      urls: hits.map((hit) => hit.url),
      query: input.question,
      extractionDepth: input.depth === "quick" ? "basic" : "advanced",
      ...(input.timeoutMs === undefined
        ? {}
        : {
            timeoutMs: getRemainingTimeoutMs(),
          }),
    };
    const untrustedPages = await this.contentExtractor.extract(extractionInput);

    /**
     * ContentExtractorPort 可能由第三方实现，
     * 因此仍然对返回值做运行时校验。
     */
    const extractedPages = z
      .array(ExtractedPageSchema)
      .max(5)
      .parse(untrustedPages);

    if (extractedPages.length === 0) {
      throw new Error(`CONTENT_EXTRACTION_EMPTY`);
    }

    const hitByUrl = new Map(
      hits.map((hit) => [canonicalizeWebUrl(hit.url), hit]),
    );

    const sources = extractedPages
      .flatMap((page) => {
        const canonicalUrl = canonicalizeWebUrl(page.url);
        const searchHit = hitByUrl.get(canonicalUrl);
        if (!searchHit) {
          return [];
        }
        return [
          {
            title: page.title ?? searchHit.title,
            url: canonicalUrl,
            snippet: page.content.slice(0, 1_200),
            publisher: page.publisher,
            publishedAt: page.publishedAt,
            retrievedAt: page.fetchedAt,
          },
        ];
      })
      .slice(0, hits.length);

    if (sources.length === 0) {
      throw new Error(`CONTENT_EXTRACTION_EMPTY`);
    }

    /**
     * 当前 summary 是确定性整理，不额外调用一次模型。
     *
     * writer 会在后续节点根据这些资料进行归纳。
     * 这样每个调研问题只产生一次搜索费用。
     */
    const summary = [
      `针对问题“${input.question}”检索到以下网页正文：`,
      ...sources.map(
        (source, i) => `${i + 1}. ${source.title}：${source.snippet}`,
      ),
    ].join("\n");
    return ResearchFindingSchema.parse({
      questionId: input.questionId,
      summary,
      sources,
    });
  }
}
