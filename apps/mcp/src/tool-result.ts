export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolCallResult {
  [key: string]: unknown;
  isError: boolean;
  content: McpTextContent[];
}

const PUBLIC_TOOL_ERROR_CODES = new Set([
  "TOOL_NOT_FOUND",
  "TOOL_INPUT_INVALID",
  "TOOL_BUDGET_EXHAUSTED",
  "TOOL_DEADLINE_EXCEEDED",
  "TOOL_CANCELLED",
  "TOOL_TIMEOUT",
  "TOOL_OUTPUT_INVALID",
  "TOOL_OUTPUT_TOO_LARGE",
  "TOOL_EXECUTION_FAILED",
  "DOCUMENT_NOT_ACCESSIBLE",
]);

export const createMcpSuccess = (value: unknown): McpToolCallResult => ({
  isError: false,
  content: [{ type: "text", text: JSON.stringify(value) }],
});

export const createMcpFailure = (code: string): McpToolCallResult => ({
  isError: true,
  content: [{ type: "text", text: code }],
});

export const getPublicToolErrorCode = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    PUBLIC_TOOL_ERROR_CODES.has(error.code)
  ) {
    return error.code;
  }
  return "TOOL_EXECUTION_FAILED";
};
