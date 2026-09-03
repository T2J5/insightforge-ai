import type {
  ToolExecutionContext,
  ToolRegistryExecutor,
} from "@insightforge/agent";
import { describe, expect, it, vi } from "vitest";

import type { McpAuthenticatedSession } from "../auth";
import { createSearchWebMcpTool } from "./search-web";

const runId = "00000000-0000-4000-8000-000000000001";

const session = (
  ownerId = "user-a",
  overrides: Partial<McpAuthenticatedSession> = {},
): McpAuthenticatedSession => ({
  ownerId,
  runId,
  deadlineAt: new Date("2099-09-03T10:01:00.000Z"),
  remainingToolCalls: 2,
  signal: new AbortController().signal,
  ...overrides,
});

const createExecuteMock = (
  result: unknown = [],
): ReturnType<typeof vi.fn<ToolRegistryExecutor["execute"]>> =>
  vi.fn<ToolRegistryExecutor["execute"]>(async () => result);

describe("search_web MCP adapter", () => {
  it("把经过认证的 Session 和校验后的输入交给统一 ToolRegistry", async () => {
    const execute = createExecuteMock();
    const tool = createSearchWebMcpTool({ execute });
    const authenticatedSession = session();

    const result = await tool.call(authenticatedSession, {
      query: "OpenAI revenue",
      searchDepth: "basic",
      maxResults: 5,
    });

    expect(result.isError).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
    const [name, context, input] = execute.mock.calls[0]!;
    expect(name).toBe("search_web");
    expect(context).toMatchObject({
      ownerId: "user-a",
      runId,
      deadlineAt: authenticatedSession.deadlineAt,
      remainingToolCalls: 2,
      signal: authenticatedSession.signal,
    } satisfies ToolExecutionContext);
    expect(input).toEqual({
      query: "OpenAI revenue",
      searchDepth: "basic",
      maxResults: 5,
    });
  });

  it("拒绝额外身份字段，客户端不能通过公共搜索绕过 Registry 上下文", async () => {
    const execute = createExecuteMock();
    const tool = createSearchWebMcpTool({ execute });

    const result = await tool.call(session(), {
      query: "OpenAI revenue",
      searchDepth: "advanced",
      maxResults: 5,
      ownerId: "user-b",
    });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "TOOL_INPUT_INVALID" }],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("把 Registry 的稳定错误码转换为 MCP 错误响应", async () => {
    const execute = vi.fn<ToolRegistryExecutor["execute"]>(async () => {
      throw Object.assign(new Error("provider secret response"), {
        code: "TOOL_TIMEOUT",
      });
    });
    const tool = createSearchWebMcpTool({ execute });

    const result = await tool.call(session(), {
      query: "OpenAI revenue",
      searchDepth: "basic",
      maxResults: 5,
    });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "TOOL_TIMEOUT" }],
    });
    expect(JSON.stringify(result)).not.toContain("provider secret");
  });

  it("隐藏非白名单异常，只返回通用错误码", async () => {
    const execute = vi.fn<ToolRegistryExecutor["execute"]>(async () => {
      throw new Error("TAVILY_API_KEY=do-not-leak");
    });
    const tool = createSearchWebMcpTool({ execute });

    const result = await tool.call(session(), {
      query: "OpenAI revenue",
      searchDepth: "basic",
      maxResults: 5,
    });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "TOOL_EXECUTION_FAILED" }],
    });
    expect(JSON.stringify(result)).not.toContain("TAVILY_API_KEY");
  });

  it("把网页搜索结果序列化为 MCP text content", async () => {
    const hits = [
      {
        title: "OpenAI company news",
        url: "https://example.com/openai",
        snippet: "OpenAI announced a new enterprise product.",
        score: 0.93,
      },
    ];
    const execute = createExecuteMock(hits);
    const tool = createSearchWebMcpTool({ execute });

    const result = await tool.call(session(), {
      query: "OpenAI enterprise product",
      searchDepth: "advanced",
      maxResults: 5,
    });

    expect(result).toEqual({
      isError: false,
      content: [{ type: "text", text: JSON.stringify(hits) }],
    });
  });
});
