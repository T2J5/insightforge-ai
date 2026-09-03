import { describe, expect, it, vi } from "vitest";

import {
  SEARCH_DOCUMENTS_TOOL_NAME,
  SEARCH_WEB_TOOL_NAME,
  createResearchToolRegistry,
} from "./research-tool-registry";

const context = {
  ownerId: "user-a",
  runId: "00000000-0000-4000-8000-000000000001",
  deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
  remainingToolCalls: 2,
  signal: new AbortController().signal,
};

describe("createResearchToolRegistry", () => {
  it("网页搜索直接调用时复用 WebSearchPort 并施加截止时间", async () => {
    const search = vi.fn(async () => [
      {
        title: "Company",
        url: "https://example.com/company",
        snippet: "Company profile",
        score: 0.9,
      },
    ]);
    const registry = createResearchToolRegistry({ webSearch: { search } });

    const result = await registry.execute(SEARCH_WEB_TOOL_NAME, context, {
      query: "company profile",
      searchDepth: "basic",
      maxResults: 3,
    });

    expect(result).toHaveLength(1);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "company profile",
        timeoutMs: expect.any(Number),
      }),
    );
  });

  it("文档检索的 ownerId 只取自可信上下文", async () => {
    const search = vi.fn(async () => []);
    const registry = createResearchToolRegistry({
      documentRetriever: { search },
    });

    await registry.execute(SEARCH_DOCUMENTS_TOOL_NAME, context, {
      query: "strategy",
      documentIds: [],
      limit: 8,
    });

    expect(search).toHaveBeenCalledWith({
      ownerId: "user-a",
      query: "strategy",
      documentIds: [],
      limit: 8,
    });
  });
});
