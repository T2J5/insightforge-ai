import {
  WebSearchInputSchema,
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

export interface SearchWebMcpTool {
  name: "search_web";
  call(
    session: McpAuthenticatedSession,
    untrustedInput: unknown,
  ): Promise<McpToolCallResult>;
}

/** MCP 协议适配器只转换输入/输出，实际搜索始终由 ToolRegistry 执行。 */
export const createSearchWebMcpTool = (
  registry: ToolRegistryExecutor,
): SearchWebMcpTool => ({
  name: "search_web",
  async call(session, untrustedInput) {
    const parsedInput = WebSearchInputSchema.safeParse(untrustedInput);
    if (!parsedInput.success) {
      return createMcpFailure("TOOL_INPUT_INVALID");
    }

    try {
      const result = await registry.execute(
        "search_web",
        createToolExecutionContext(session),
        parsedInput.data,
      );
      return createMcpSuccess(result);
    } catch (error) {
      return createMcpFailure(getPublicToolErrorCode(error));
    }
  },
});
