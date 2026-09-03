import {
  SearchUploadedDocumentsInputSchema,
  WebSearchInputSchema,
  createResearchToolRegistry,
  createTavilyWebSearch,
  type ToolRegistryExecutor,
} from "@insightforge/agent";
import { createDatabase, type DatabaseConnection } from "@insightforge/db";
import {
  HybridRetriever,
  OpenAiEmbeddingModel,
  PostgresDocumentStore,
} from "@insightforge/retrieval";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import {
  createEnvironmentMcpSessionProvider,
  type McpSessionProvider,
} from "./auth";
import { createSearchUploadedDocumentsMcpTool } from "./tools/search-documents";
import { createSearchWebMcpTool } from "./tools/search-web";
import { createMcpFailure, getPublicToolErrorCode } from "./tool-result";

const requireEnvironmentVariable = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
};

/**
 * 协议工厂保持可注入、可测试。私有文档工具必须由调用者显式开启，
 * 默认 MCP Server 只注册公开网页搜索。
 */
export const createInsightForgeMcpServer = (
  registry: ToolRegistryExecutor,
  sessions: McpSessionProvider,
  options: { enablePrivateDocuments?: boolean } = {},
): McpServer => {
  const server = new McpServer({ name: "insightforge", version: "0.1.0" });
  const searchWeb = createSearchWebMcpTool(registry);

  server.registerTool(
    searchWeb.name,
    {
      title: "Search the public web",
      description:
        "Search public web sources for enterprise research. Identity and budgets are supplied by the server.",
      inputSchema: WebSearchInputSchema,
    },
    async (input, context) => {
      try {
        return await searchWeb.call(
          sessions.create(context.mcpReq.signal),
          input,
        );
      } catch (error) {
        return createMcpFailure(getPublicToolErrorCode(error));
      }
    },
  );

  if (options.enablePrivateDocuments === true) {
    const searchDocuments = createSearchUploadedDocumentsMcpTool(registry);
    server.registerTool(
      searchDocuments.name,
      {
        title: "Search uploaded documents",
        description:
          "Search uploaded documents scoped to the explicitly configured owner.",
        inputSchema: SearchUploadedDocumentsInputSchema,
      },
      async (input, context) => {
        try {
          return await searchDocuments.call(
            sessions.create(context.mcpReq.signal),
            input,
          );
        } catch (error) {
          return createMcpFailure(getPublicToolErrorCode(error));
        }
      },
    );
  }

  return server;
};

interface McpRuntime {
  registry: ToolRegistryExecutor;
  sessions: McpSessionProvider;
  enablePrivateDocuments: boolean;
  database?: DatabaseConnection;
}

const createRuntime = (): McpRuntime => {
  const webSearch = createTavilyWebSearch(
    requireEnvironmentVariable("SEARCH_API_KEY"),
  );
  const enablePrivateDocuments =
    process.env.INSIGHTFORGE_MCP_ENABLE_PRIVATE_DOCUMENTS === "true";

  if (!enablePrivateDocuments) {
    return {
      registry: createResearchToolRegistry({ webSearch }),
      sessions: createEnvironmentMcpSessionProvider(),
      enablePrivateDocuments: false,
    };
  }

  const database = createDatabase(requireEnvironmentVariable("DATABASE_URL"));
  const documentStore = new PostgresDocumentStore(database.db);
  const embeddings = new OpenAiEmbeddingModel({
    apiKey:
      process.env.EMBEDDING_API_KEY?.trim() ||
      requireEnvironmentVariable("MODEL_API_KEY"),
    model: process.env.EMBEDDING_MODEL?.trim(),
    baseUrl: process.env.EMBEDDING_BASE_URL?.trim(),
  });

  return {
    registry: createResearchToolRegistry({
      webSearch,
      documentRetriever: new HybridRetriever(documentStore, embeddings),
    }),
    sessions: createEnvironmentMcpSessionProvider(),
    enablePrivateDocuments: true,
    database,
  };
};

const main = async (): Promise<void> => {
  const runtime = createRuntime();
  const close = async () => runtime.database?.close();
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

  serveStdio(() =>
    createInsightForgeMcpServer(runtime.registry, runtime.sessions, {
      enablePrivateDocuments: runtime.enablePrivateDocuments,
    }),
  );
  console.error("InsightForge MCP server running on stdio");
};

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  void main().catch((error: unknown) => {
    console.error(
      "InsightForge MCP server failed:",
      error instanceof Error ? error.message : "UNKNOWN_ERROR",
    );
    process.exitCode = 1;
  });
}
