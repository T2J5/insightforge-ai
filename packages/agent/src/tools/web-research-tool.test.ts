import { describe, expect, it } from "vitest";

import type {
  ContentExtractionInput,
  ContentExtractorPort,
  ExtractedPage,
} from "./content-extractor";
import { WebResearchTool } from "./web-research-tool";
import type { WebSearchHit, WebSearchInput, WebSearchPort } from "./web-search";

const hits: WebSearchHit[] = [
  {
    title: "Search Result Title",
    url: "https://example.com/technology",
    snippet: "This search snippet must not be used after extraction.",
    score: 0.92,
  },
];

const pages: ExtractedPage[] = [
  {
    title: "Extracted Page Title",
    url: "https://example.com/technology",
    content: "Relevant content extracted directly from the web page.",
  },
];

class FakeWebSearch implements WebSearchPort {
  readonly calls: WebSearchInput[] = [];

  constructor(private readonly results: WebSearchHit[]) {}

  async search(input: WebSearchInput): Promise<WebSearchHit[]> {
    this.calls.push(input);
    return this.results;
  }
}

class FakeContentExtractor implements ContentExtractorPort {
  readonly calls: ContentExtractionInput[] = [];

  constructor(private readonly results: ExtractedPage[]) {}

  async extract(input: ContentExtractionInput): Promise<ExtractedPage[]> {
    this.calls.push(input);
    return this.results;
  }
}

const baseInput = {
  company: "ByteDance",
  focus: "technology" as const,
  questionId: "q1",
  question: "ByteDance 的核心技术能力是什么？",
};

describe("WebResearchTool", () => {
  it("searches and batch-extracts sources for quick research", async () => {
    const webSearch = new FakeWebSearch(hits);
    const contentExtractor = new FakeContentExtractor(pages);
    const researchTool = new WebResearchTool(webSearch, contentExtractor);

    const result = await researchTool.research({
      ...baseInput,
      depth: "quick",
    });

    expect(webSearch.calls).toEqual([
      {
        query: "ByteDance ByteDance 的核心技术能力是什么？",
        searchDepth: "basic",
        maxResults: 3,
      },
    ]);
    expect(contentExtractor.calls).toEqual([
      {
        urls: ["https://example.com/technology"],
        query: "ByteDance 的核心技术能力是什么？",
        extractionDepth: "basic",
      },
    ]);
    expect(result.sources).toEqual([
      {
        title: "Extracted Page Title",
        url: "https://example.com/technology",
        snippet: "Relevant content extracted directly from the web page.",
      },
    ]);
    expect(result.summary).toContain(
      "Relevant content extracted directly from the web page.",
    );
    expect(result.summary).not.toContain(
      "This search snippet must not be used after extraction.",
    );
  });

  it("uses advanced search and extraction for deep research", async () => {
    const webSearch = new FakeWebSearch(hits);
    const contentExtractor = new FakeContentExtractor(pages);
    const researchTool = new WebResearchTool(webSearch, contentExtractor);

    await researchTool.research({ ...baseInput, depth: "deep" });

    expect(webSearch.calls[0]).toEqual({
      query: "ByteDance ByteDance 的核心技术能力是什么？",
      searchDepth: "advanced",
      maxResults: 5,
    });
    expect(contentExtractor.calls[0]).toEqual({
      urls: ["https://example.com/technology"],
      query: "ByteDance 的核心技术能力是什么？",
      extractionDepth: "advanced",
    });
  });

  it("uses the search title when extraction has no title", async () => {
    const researchTool = new WebResearchTool(
      new FakeWebSearch(hits),
      new FakeContentExtractor([{ ...pages[0]!, title: null }]),
    );

    const result = await researchTool.research({
      ...baseInput,
      depth: "quick",
    });

    expect(result.sources[0]?.title).toBe("Search Result Title");
  });

  it("does not call extraction when search returns no sources", async () => {
    const contentExtractor = new FakeContentExtractor(pages);
    const researchTool = new WebResearchTool(
      new FakeWebSearch([]),
      contentExtractor,
    );

    await expect(
      researchTool.research({ ...baseInput, depth: "quick" }),
    ).rejects.toThrow("SEARCH_RESULTS_EMPTY");
    expect(contentExtractor.calls).toHaveLength(0);
  });

  it("fails consistently when extraction returns no usable content", async () => {
    const researchTool = new WebResearchTool(
      new FakeWebSearch(hits),
      new FakeContentExtractor([]),
    );

    await expect(
      researchTool.research({ ...baseInput, depth: "quick" }),
    ).rejects.toThrow("CONTENT_EXTRACTION_EMPTY");
  });

  it("rejects extracted pages that were not present in search results", async () => {
    const researchTool = new WebResearchTool(
      new FakeWebSearch(hits),
      new FakeContentExtractor([
        { ...pages[0]!, url: "https://unrelated.example.com/page" },
      ]),
    );

    await expect(
      researchTool.research({ ...baseInput, depth: "quick" }),
    ).rejects.toThrow("CONTENT_EXTRACTION_EMPTY");
  });

  it("passes the remaining operation timeout to search and extraction", async () => {
    const timestamps = [1_000, 1_000, 1_250];
    const webSearch = new FakeWebSearch(hits);
    const contentExtractor = new FakeContentExtractor(pages);
    const researchTool = new WebResearchTool(
      webSearch,
      contentExtractor,
      () => timestamps.shift() ?? 1_250,
    );

    await researchTool.research({
      ...baseInput,
      depth: "quick",
      timeoutMs: 1_000,
    });

    expect(webSearch.calls[0]).toMatchObject({ timeoutMs: 1_000 });
    expect(contentExtractor.calls[0]).toMatchObject({ timeoutMs: 750 });
  });

  it("does not start extraction after the operation timeout is exhausted", async () => {
    const timestamps = [1_000, 1_000, 2_000];
    const contentExtractor = new FakeContentExtractor(pages);
    const researchTool = new WebResearchTool(
      new FakeWebSearch(hits),
      contentExtractor,
      () => timestamps.shift() ?? 2_000,
    );

    await expect(
      researchTool.research({
        ...baseInput,
        depth: "quick",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("RESEARCH_TOOL_TIMEOUT");
    expect(contentExtractor.calls).toHaveLength(0);
  });
});
