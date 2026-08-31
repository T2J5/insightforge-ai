import { describe, expect, it, vi } from "vitest";

import type {
  FetchWebPageInput,
  FetchedPage,
  WebPagePort,
} from "@insightforge/domain";

import { BoundedContentExtractor } from "./bounded-content-extractor";

const page: FetchedPage = {
  canonicalUrl: "https://example.com/news",
  title: "Example News",
  publisher: "Example Inc.",
  publishedAt: "2026-08-30T08:00:00.000Z",
  fetchedAt: "2026-08-31T08:00:00.000Z",
  content: "A verified paragraph from the fetched page.",
  contentHash: "a".repeat(64),
  httpStatus: 200,
  contentType: "text/html",
};

describe("BoundedContentExtractor", () => {
  it("批量抓取并透传来源元数据和超时", async () => {
    const fetch = vi.fn(async (_input: FetchWebPageInput) => page);
    const extractor = new BoundedContentExtractor({ fetch } as WebPagePort);

    await expect(
      extractor.extract({
        urls: ["https://example.com/news"],
        query: "example",
        extractionDepth: "basic",
        timeoutMs: 1_500,
      }),
    ).resolves.toEqual([
      {
        url: page.canonicalUrl,
        title: page.title,
        publisher: page.publisher,
        publishedAt: page.publishedAt,
        fetchedAt: page.fetchedAt,
        content: page.content,
      },
    ]);
    expect(fetch).toHaveBeenCalledWith({
      url: "https://example.com/news",
      timeoutMs: 1_500,
    });
  });

  it("保留同批次中成功抓取的网页", async () => {
    const fetch = vi
      .fn<(input: FetchWebPageInput) => Promise<FetchedPage>>()
      .mockRejectedValueOnce(new Error("PAGE_BLOCKED"))
      .mockResolvedValueOnce(page);
    const extractor = new BoundedContentExtractor({ fetch } as WebPagePort);

    const result = await extractor.extract({
      urls: ["https://blocked.example.com", "https://example.com/news"],
      query: "example",
      extractionDepth: "advanced",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe(page.canonicalUrl);
  });
});
