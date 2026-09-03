import type {
  ToolExecutionContext,
  ToolRegistryExecutor,
} from "@insightforge/agent";
import { describe, expect, it, vi } from "vitest";

import {
  createSearchUploadedDocumentsMcpTool,
  type McpAuthenticatedSession,
} from "./search-documents";

const runId = "00000000-0000-4000-8000-000000000001";
const documentId = "00000000-0000-4000-8000-000000000002";

const session = (
  ownerId: string,
  overrides: Partial<McpAuthenticatedSession> = {},
): McpAuthenticatedSession => ({
  ownerId,
  runId,
  // 通用用例使用足够远的未来时间，避免测试受实际运行日期和时刻影响。
  deadlineAt: new Date("2099-09-03T10:01:00.000Z"),
  remainingToolCalls: 2,
  signal: new AbortController().signal,
  ...overrides,
});

describe("search_uploaded_documents MCP adapter", () => {
  it("从认证 Session 构造上下文，绝不从工具参数接收 ownerId", async () => {
    const execute = vi.fn(
      async (
        _name: string,
        _context: ToolExecutionContext,
        _input: unknown,
      ): Promise<unknown> => [],
    );
    const tool = createSearchUploadedDocumentsMcpTool({
      execute,
    } as ToolRegistryExecutor);
    const authenticatedSession = session("user-a");

    const result = await tool.call(authenticatedSession, {
      query: "strategy",
      documentIds: [documentId],
      limit: 8,
    });

    expect(result.isError).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
    const [name, context, input] = execute.mock.calls[0]!;
    expect(name).toBe("search_uploaded_documents");
    expect(context).toMatchObject({
      ownerId: "user-a",
      runId,
      deadlineAt: authenticatedSession.deadlineAt,
      remainingToolCalls: 2,
      signal: authenticatedSession.signal,
    } satisfies ToolExecutionContext);
    expect(input).toEqual({
      query: "strategy",
      documentIds: [documentId],
      limit: 8,
    });
    expect(input).not.toHaveProperty("ownerId");
  });

  it("拒绝客户端在工具参数中伪造 ownerId", async () => {
    const execute = vi.fn(
      async (
        _name: string,
        _context: ToolExecutionContext,
        _input: unknown,
      ): Promise<unknown> => [],
    );
    const tool = createSearchUploadedDocumentsMcpTool({
      execute,
    } as ToolRegistryExecutor);

    const result = await tool.call(session("user-a"), {
      query: "private strategy",
      documentIds: [documentId],
      ownerId: "user-b",
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "TOOL_INPUT_INVALID" }],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("越权文档错误使用协议安全错误码，不泄露内部异常", async () => {
    const execute = vi.fn(
      async (
        _name: string,
        _context: ToolExecutionContext,
        _input: unknown,
      ): Promise<unknown> => {
        throw Object.assign(
          new Error("document owner=user-b database-row=secret"),
          { code: "DOCUMENT_NOT_ACCESSIBLE" },
        );
      },
    );
    const tool = createSearchUploadedDocumentsMcpTool({
      execute,
    } as ToolRegistryExecutor);

    const result = await tool.call(session("user-a"), {
      query: "strategy",
      documentIds: [documentId],
    });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "DOCUMENT_NOT_ACCESSIBLE" }],
    });
    expect(JSON.stringify(result)).not.toContain("database-row");
    expect(JSON.stringify(result)).not.toContain("user-b");
  });

  it("把成功输出转换为 MCP text content", async () => {
    const chunks = [
      {
        id: "chunk-1",
        documentId,
        content: "Annual recurring revenue increased.",
        score: 0.91,
      },
    ];
    const tool = createSearchUploadedDocumentsMcpTool({
      execute: vi.fn(async () => chunks),
    } as ToolRegistryExecutor);

    const result = await tool.call(session("user-a"), {
      query: "revenue",
      documentIds: [documentId],
    });

    expect(result).toEqual({
      isError: false,
      content: [{ type: "text", text: JSON.stringify(chunks) }],
    });
  });
});
