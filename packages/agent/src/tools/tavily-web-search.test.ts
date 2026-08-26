import { describe, expect, it, vi } from "vitest";

import {
  createTavilyWebSearch,
  TavilyWebSearch,
  type TavilySearchClient,
} from "./tavily-web-search";

const createClient = (
  results: Awaited<ReturnType<TavilySearchClient["search"]>>["results"],
) => {
  const search = vi.fn<TavilySearchClient["search"]>(async (query) => ({
    query,
    responseTime: 0.1,
    images: [],
    results,
    requestId: "request-1",
  }));

  return {
    client: { search } satisfies TavilySearchClient,
    search,
  };
};

const validResult = {
  title: "ByteDance Technology",
  url: "https://example.com/technology",
  content: "Recommendation systems and data infrastructure.",
  score: 0.92,
  publishedDate: "2026-08-01",
  id: "result-1",
};

describe("TavilyWebSearch", () => {
  it("maps the project search request to Tavily and normalizes results", async () => {
    const { client, search } = createClient([validResult]);
    const webSearch = new TavilyWebSearch(client);

    const result = await webSearch.search({
      query: "ByteDance recommendation technology",
      searchDepth: "basic",
      maxResults: 3,
    });

    expect(result).toEqual([
      {
        title: "ByteDance Technology",
        url: "https://example.com/technology",
        snippet: "Recommendation systems and data infrastructure.",
        score: 0.92,
      },
    ]);
    expect(search).toHaveBeenCalledWith("ByteDance recommendation technology", {
      searchDepth: "basic",
      topic: "general",
      maxResults: 3,
      includeAnswer: false,
      includeImages: false,
      includeRawContent: false,
      autoParameters: false,
      includeUsage: true,
    });
  });

  it("filters malformed provider results without losing valid results", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client } = createClient([
      validResult,
      {
        ...validResult,
        id: "invalid-url",
        url: "not-a-url",
      },
      {
        ...validResult,
        id: "invalid-score",
        score: 2,
      },
    ]);
    const webSearch = new TavilyWebSearch(client);

    const result = await webSearch.search({
      query: "ByteDance",
      searchDepth: "basic",
      maxResults: 3,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe("https://example.com/technology");
    warn.mockRestore();
  });

  it("rejects invalid input before calling the provider", async () => {
    const { client, search } = createClient([]);
    const webSearch = new TavilyWebSearch(client);

    await expect(
      webSearch.search({
        query: "   ",
        searchDepth: "basic",
        maxResults: 3,
      }),
    ).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });

  it("never returns more hits than the project contract allows", async () => {
    const { client } = createClient(
      Array.from({ length: 4 }, (_, index) => ({
        ...validResult,
        id: `result-${index + 1}`,
        url: `https://example.com/technology-${index + 1}`,
      })),
    );
    const webSearch = new TavilyWebSearch(client);

    const result = await webSearch.search({
      query: "ByteDance",
      searchDepth: "basic",
      maxResults: 2,
    });

    expect(result).toHaveLength(2);
  });

  it("converts the project millisecond timeout to Tavily seconds", async () => {
    const { client, search } = createClient([validResult]);
    const webSearch = new TavilyWebSearch(client);

    await webSearch.search({
      query: "ByteDance",
      searchDepth: "basic",
      maxResults: 3,
      timeoutMs: 1_500,
    });

    expect(search.mock.calls[0]?.[1]).toMatchObject({ timeout: 2 });
    expect(search.mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
  });
});

describe("createTavilyWebSearch", () => {
  it("rejects an empty Tavily API key", () => {
    expect(() => createTavilyWebSearch("   ")).toThrow(
      "TAVILY_API_KEY_REQUIRED",
    );
  });
});
