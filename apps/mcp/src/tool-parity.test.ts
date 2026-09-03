import {
  SEARCH_WEB_TOOL_NAME,
  createResearchToolRegistry,
  type ToolExecutionContext,
} from "@insightforge/agent";
import { describe, expect, it, vi } from "vitest";

import type { McpAuthenticatedSession } from "./auth";
import { createSearchWebMcpTool } from "./tools/search-web";

describe("direct and MCP tool parity", () => {
  it("网页工具的直接调用和 MCP 调用返回相同业务结果", async () => {
    const hits = [
      {
        title: "Company profile",
        url: "https://example.com/company",
        snippet: "Public company information",
        score: 0.9,
      },
    ];
    const registry = createResearchToolRegistry({
      webSearch: { search: vi.fn(async () => hits) },
    });
    const signal = new AbortController().signal;
    const context: ToolExecutionContext = {
      ownerId: "user-a",
      runId: "00000000-0000-4000-8000-000000000001",
      deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
      remainingToolCalls: 2,
      signal,
    };
    const input = {
      query: "company profile",
      searchDepth: "basic" as const,
      maxResults: 3,
    };

    const direct = await registry.execute(SEARCH_WEB_TOOL_NAME, context, input);
    const session: McpAuthenticatedSession = context;
    const throughMcp = await createSearchWebMcpTool(registry).call(
      session,
      input,
    );

    expect(JSON.parse(throughMcp.content[0]!.text)).toEqual(direct);
    expect(throughMcp.isError).toBe(false);
  });
});
