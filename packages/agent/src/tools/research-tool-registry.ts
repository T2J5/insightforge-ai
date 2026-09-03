import { RetrievedChunkSchema } from "@insightforge/domain";
import { z } from "zod";

import {
  ResearchFindingSchema,
  ResearchToolInputSchema,
  type ResearchTool,
} from "./research-tool";
import {
  SearchUploadedDocumentsInputSchema,
  SearchUploadedDocumentsTool,
  type UploadedDocumentRetriever,
} from "./search-uploaded-documents";
import {
  WebSearchHitSchema,
  WebSearchInputSchema,
  type WebSearchPort,
} from "./web-search";
import {
  ToolRegistry,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolRegistryOptions,
} from "./tool-registry";

export const INTERNAL_RESEARCH_TOOL_NAME = "research";
export const SEARCH_WEB_TOOL_NAME = "search_web";
export const SEARCH_DOCUMENTS_TOOL_NAME = "search_uploaded_documents";

const remainingTimeoutMs = (
  context: ToolExecutionContext,
  requested?: number,
): number => {
  const remaining = context.deadlineAt.getTime() - Date.now();
  if (remaining < 1) return 1;
  return Math.max(1, Math.min(requested ?? remaining, remaining));
};

export const createWebSearchToolDefinition = (
  webSearch: WebSearchPort,
): ToolDefinition<
  z.infer<typeof WebSearchInputSchema>,
  z.infer<typeof WebSearchHitSchema>[]
> => ({
  name: SEARCH_WEB_TOOL_NAME,
  inputSchema: WebSearchInputSchema,
  outputSchema: z.array(WebSearchHitSchema).max(10),
  async execute(context, input) {
    return webSearch.search({
      ...input,
      timeoutMs: remainingTimeoutMs(context, input.timeoutMs),
    });
  },
});

export const createUploadedDocumentSearchToolDefinition = (
  retriever: UploadedDocumentRetriever,
): ToolDefinition<
  z.infer<typeof SearchUploadedDocumentsInputSchema>,
  z.infer<typeof RetrievedChunkSchema>[]
> => {
  const tool = new SearchUploadedDocumentsTool(retriever);
  return {
    name: SEARCH_DOCUMENTS_TOOL_NAME,
    inputSchema: SearchUploadedDocumentsInputSchema,
    outputSchema: z.array(RetrievedChunkSchema).max(20),
    execute: (context, input) => tool.execute(context, input),
  };
};

export const createInternalResearchToolDefinition = (
  researchTool: ResearchTool,
): ToolDefinition<
  z.infer<typeof ResearchToolInputSchema>,
  z.infer<typeof ResearchFindingSchema>
> => ({
  name: INTERNAL_RESEARCH_TOOL_NAME,
  inputSchema: ResearchToolInputSchema,
  outputSchema: ResearchFindingSchema,
  async execute(context, input) {
    return researchTool.research({
      ...input,
      timeoutMs: remainingTimeoutMs(context, input.timeoutMs),
    });
  },
});

export interface CreateResearchToolRegistryInput {
  webSearch?: WebSearchPort;
  documentRetriever?: UploadedDocumentRetriever;
  researchTool?: ResearchTool;
  options?: ToolRegistryOptions;
}

/** 创建 Agent 与 MCP 可以共享的同一类工具注册表。 */
export const createResearchToolRegistry = ({
  webSearch,
  documentRetriever,
  researchTool,
  options,
}: CreateResearchToolRegistryInput): ToolRegistry => {
  const registry = new ToolRegistry(options);
  if (webSearch) registry.register(createWebSearchToolDefinition(webSearch));
  if (documentRetriever) {
    registry.register(
      createUploadedDocumentSearchToolDefinition(documentRetriever),
    );
  }
  if (researchTool) {
    registry.register(createInternalResearchToolDefinition(researchTool));
  }
  return registry;
};
