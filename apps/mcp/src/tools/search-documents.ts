import {
  SearchUploadedDocumentsInputSchema,
  type ToolRegistryExecutor,
} from "@insightforge/agent";

import {
  createToolExecutionContext,
  type McpAuthenticatedSession,
} from "../auth";
import {
  createMcpFailure,
  createMcpSuccess,
  getPublicToolErrorCode,
  type McpToolCallResult,
} from "../tool-result";

/**
 * 为了让测试和其他 Adapter 可以从当前模块获取 Session 类型。
 */
export type { McpAuthenticatedSession } from "../auth";

/**
 * 当前 Adapter 使用的最小 MCP 文本响应结构。
 *
 * 后面接入 @modelcontextprotocol/server 时，
 * 这个结构与 CallToolResult 的 content 文本块兼容。
 */
export interface SearchUploadedDocumentsMcpTool {
  name: "search_uploaded_documents";

  call(
    session: McpAuthenticatedSession,
    untrustedInput: unknown,
  ): Promise<McpToolCallResult>;
}

/**
 * 创建上传文档搜索的 MCP Adapter。
 *
 * Adapter 只负责四件事：
 *
 * 1. 校验协议输入；
 * 2. 从认证 Session 构造可信上下文；
 * 3. 调用统一 ToolRegistry；
 * 4. 转换成协议安全的 MCP 响应。
 *
 * 它不应该直接依赖 HybridRetriever、PostgreSQL 或 Embedding Provider。
 */
export const createSearchUploadedDocumentsMcpTool = (
  registry: ToolRegistryExecutor,
): SearchUploadedDocumentsMcpTool => ({
  name: "search_uploaded_documents",

  async call(
    session: McpAuthenticatedSession,
    untrustedInput: unknown,
  ): Promise<McpToolCallResult> {
    /**
     * MCP Adapter 在协议边界先校验一次。
     *
     * ToolRegistry 内部还会再次校验，这是有意的：
     *
     * - Adapter 校验保护 MCP 协议边界；
     * - Registry 校验保护内部统一工具边界。
     */
    const parsedInput =
      SearchUploadedDocumentsInputSchema.safeParse(untrustedInput);

    if (!parsedInput.success) {
      return createMcpFailure("TOOL_INPUT_INVALID");
    }

    try {
      const context = createToolExecutionContext(session);

      const result = await registry.execute(
        "search_uploaded_documents",
        context,
        parsedInput.data,
      );

      return createMcpSuccess(result);
    } catch (error) {
      return createMcpFailure(getPublicToolErrorCode(error));
    }
  },
});
