import type { WebPagePort } from "@insightforge/domain";

import {
  ContentExtractionInputSchema,
  ExtractedPageSchema,
  type ContentExtractionInput,
  type ContentExtractorPort,
  type ExtractedPage,
} from "./content-extractor";

/**
 * 将安全、受限的单页抓取端口适配成 WebResearchTool 使用的批量正文端口。
 * 单个网页失败不会丢弃同批次中已经成功抓取的来源。
 */
export class BoundedContentExtractor implements ContentExtractorPort {
  constructor(private readonly pageFetcher: WebPagePort) {}

  async extract(
    untrustedInput: ContentExtractionInput,
  ): Promise<ExtractedPage[]> {
    const input = ContentExtractionInputSchema.parse(untrustedInput);
    const urls = [...new Set(input.urls)].slice(0, 5);
    const settled = await Promise.allSettled(
      urls.map((url) =>
        this.pageFetcher.fetch({
          url,
          ...(input.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.timeoutMs }),
        }),
      ),
    );

    return settled.flatMap((result) => {
      if (result.status === "rejected") return [];
      const page = result.value;
      const parsed = ExtractedPageSchema.safeParse({
        url: page.canonicalUrl,
        title: page.title,
        publisher: page.publisher,
        publishedAt: page.publishedAt,
        fetchedAt: page.fetchedAt,
        content: page.content.slice(0, 6_000),
      });
      return parsed.success ? [parsed.data] : [];
    });
  }
}
