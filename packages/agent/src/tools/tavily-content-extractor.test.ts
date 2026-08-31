import { describe, expect, it, vi } from "vitest";

import {
  createTavilyContentExtractor,
  TavilyContentExtractor,
  type TavilyExtractClient,
} from "./tavily-content-extractor";

const validResult = {
  url: "https://example.com/technology",
  title: "  ByteDance Technology  ",
  rawContent: "  Extracted recommendation system content.  ",
};

const createClient = (
  results: Awaited<ReturnType<TavilyExtractClient["extract"]>>["results"],
) => {
  const extract = vi.fn<TavilyExtractClient["extract"]>(async () => ({
    results,
    failedResults: [],
    responseTime: 0.1,
    requestId: "request-1",
  }));

  return {
    client: { extract } satisfies TavilyExtractClient,
    extract,
  };
};

describe("TavilyContentExtractor", () => {
  it("deduplicates URLs, maps options, and normalizes extracted pages", async () => {
    const { client, extract } = createClient([validResult]);
    const contentExtractor = new TavilyContentExtractor(
      client,
      () => new Date("2026-08-31T08:00:00.000Z"),
    );

    const result = await contentExtractor.extract({
      urls: [
        "https://example.com/technology",
        "https://example.com/technology",
      ],
      query: "ByteDance 的核心技术能力是什么？",
      extractionDepth: "basic",
    });

    expect(extract).toHaveBeenCalledWith(["https://example.com/technology"], {
      extractDepth: "basic",
      format: "markdown",
      includeImages: false,
      includeFavicon: false,
      includeUsage: true,
      query: "ByteDance 的核心技术能力是什么？",
      chunksPerSource: 2,
    });
    expect(result).toEqual([
      {
        url: "https://example.com/technology",
        title: "ByteDance Technology",
        publisher: null,
        publishedAt: null,
        fetchedAt: "2026-08-31T08:00:00.000Z",
        content: "Extracted recommendation system content.",
      },
    ]);
  });

  it("uses more relevant chunks for advanced extraction", async () => {
    const { client, extract } = createClient([validResult]);
    const contentExtractor = new TavilyContentExtractor(client);

    await contentExtractor.extract({
      urls: ["https://example.com/technology"],
      query: "ByteDance infrastructure",
      extractionDepth: "advanced",
    });

    expect(extract.mock.calls[0]?.[1]).toMatchObject({
      extractDepth: "advanced",
      chunksPerSource: 3,
    });
  });

  it("filters malformed and duplicate provider results", async () => {
    const { client } = createClient([
      validResult,
      validResult,
      { ...validResult, url: "not-a-url" },
      {
        ...validResult,
        url: "https://example.com/empty",
        rawContent: "   ",
      },
    ]);
    const contentExtractor = new TavilyContentExtractor(client);

    const result = await contentExtractor.extract({
      urls: ["https://example.com/technology"],
      query: "ByteDance technology",
      extractionDepth: "basic",
    });

    expect(result).toHaveLength(1);
  });

  it("rejects invalid input before calling Tavily", async () => {
    const { client, extract } = createClient([]);
    const contentExtractor = new TavilyContentExtractor(client);

    await expect(
      contentExtractor.extract({
        urls: [],
        query: "ByteDance technology",
        extractionDepth: "basic",
      }),
    ).rejects.toThrow();
    expect(extract).not.toHaveBeenCalled();
  });

  it("converts the project millisecond timeout to Tavily seconds", async () => {
    const { client, extract } = createClient([validResult]);
    const contentExtractor = new TavilyContentExtractor(client);

    await contentExtractor.extract({
      urls: ["https://example.com/technology"],
      query: "ByteDance technology",
      extractionDepth: "basic",
      timeoutMs: 1_500,
    });

    expect(extract.mock.calls[0]?.[1]).toMatchObject({ timeout: 2 });
    expect(extract.mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
  });
});

describe("createTavilyContentExtractor", () => {
  it("rejects an empty Tavily API key", () => {
    expect(() => createTavilyContentExtractor("   ")).toThrow(
      "TAVILY_API_KEY_REQUIRED",
    );
  });
});
