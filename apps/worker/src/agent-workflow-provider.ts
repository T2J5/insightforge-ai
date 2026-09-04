import {
  createOpenAiStructuredModel,
  BoundedContentExtractor,
  BoundedWebPageFetcher,
  CachedWebPage,
  CachedWebSearch,
  createTavilyWebSearch,
  WebResearchTool,
  createResearchGraph,
  ResearchBudgetsSchema,
  DEFAULT_RESEARCH_BUDGETS,
  ResearchCache,
} from "@insightforge/agent";
import { AgentResearchWorkflow } from "./agent-workflow";
import { getWorkerDatabaseConnection } from "./database";
import { getWorkerRedis } from "./redis";
import {
  EvidenceRepository,
  ReportRepository,
  RunRepository,
} from "@insightforge/db";
import {
  InstrumentedStructuredModel,
  JsonConsoleTelemetrySink,
  Telemetry,
} from "@insightforge/observability";
import { DatabaseUsageSink } from "./database-usage-sink";
import { ProgressPublisher } from "./progress-publisher";
import { CancellationGuard } from "./cancellation";
import { getWorkerAgentCheckpointer } from "./checkpointer";

const requireEnvironmentVariable = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
};

const readOptionalNonNegativeNumber = (
  name: string,
  fallback: number,
): number => {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }
  const num = Number(rawValue);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(
      `Environment variable ${name} must be a non-negative number`,
    );
  }
  return num;
};

const readOptionalNonNegativeInteger = (
  name: string,
  fallback: number,
): number => {
  const value = readOptionalNonNegativeNumber(name, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(
      `Environment variable ${name} must be a non-negative integer`,
    );
  }
  return value;
};

const readOptionalRetryCount = (name: string, fallback: number): number => {
  const value = readOptionalNonNegativeNumber(name, fallback);

  if (!Number.isInteger(value) || value > 5) {
    throw new Error(
      `Environment variable ${name} must be an integer between 0 and 5`,
    );
  }

  return value;
};
const readOptionalPositiveInteger = (
  name: string,
  fallback: number,
): number => {
  const value = readOptionalNonNegativeNumber(name, fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return value;
};

/**
 * 创建生产环境使用的 Agent Workflow。
 */
export const createAgentResearchWorkflow = (): AgentResearchWorkflow => {
  const modelTimeoutMs = readOptionalPositiveInteger(
    "MODEL_TIMEOUT_MS",
    120_000,
  );
  const searchTimeoutMs = readOptionalPositiveInteger(
    "SEARCH_TIMEOUT_MS",
    30_000,
  );
  const budgets = ResearchBudgetsSchema.parse({
    quick: {
      maxSearchCount: readOptionalNonNegativeInteger(
        "AGENT_QUICK_MAX_SEARCHES",
        DEFAULT_RESEARCH_BUDGETS.quick.maxSearchCount,
      ),
      maxTokenUsage: readOptionalNonNegativeInteger(
        "AGENT_QUICK_MAX_TOKENS",
        DEFAULT_RESEARCH_BUDGETS.quick.maxTokenUsage,
      ),

      maxEstimatedCostCny: readOptionalNonNegativeNumber(
        "AGENT_QUICK_MAX_COST_CNY",
        DEFAULT_RESEARCH_BUDGETS.quick.maxEstimatedCostCny,
      ),

      maxDurationMs: readOptionalPositiveInteger(
        "AGENT_QUICK_MAX_DURATION_MS",
        DEFAULT_RESEARCH_BUDGETS.quick.maxDurationMs,
      ),
    },
    deep: {
      maxSearchCount: readOptionalNonNegativeInteger(
        "AGENT_DEEP_MAX_SEARCHES",
        DEFAULT_RESEARCH_BUDGETS.deep.maxSearchCount,
      ),

      maxTokenUsage: readOptionalNonNegativeInteger(
        "AGENT_DEEP_MAX_TOKENS",
        DEFAULT_RESEARCH_BUDGETS.deep.maxTokenUsage,
      ),

      maxEstimatedCostCny: readOptionalNonNegativeNumber(
        "AGENT_DEEP_MAX_COST_CNY",
        DEFAULT_RESEARCH_BUDGETS.deep.maxEstimatedCostCny,
      ),

      maxDurationMs: readOptionalPositiveInteger(
        "AGENT_DEEP_MAX_DURATION_MS",
        DEFAULT_RESEARCH_BUDGETS.deep.maxDurationMs,
      ),
    },
  });
  /**
   * 先校验外部服务配置。
   *
   * 如果配置错误，应在 Worker 启动阶段失败，
   * 而不是等到消费第一个任务时才失败。
   */
  const modelApiKey = requireEnvironmentVariable("MODEL_API_KEY");
  const searchApiKey = requireEnvironmentVariable("SEARCH_API_KEY");
  const modelName = process.env.MODEL_NAME?.trim() || "gpt-5.6-luna";
  const baseModel = createOpenAiStructuredModel({
    apiKey: modelApiKey,
    modelName,
    baseUrl: process.env.MODEL_BASE_URL?.trim() || undefined,
    maxRetries: readOptionalRetryCount("MODEL_MAX_RETRIES", 2),
    timeoutMs: modelTimeoutMs,
    maxOutputTokens: readOptionalPositiveInteger(
      "MODEL_MAX_OUTPUT_TOKENS",
      8_000,
    ),
    inputCostCnyPerMillionTokens: readOptionalNonNegativeNumber(
      "MODEL_INPUT_COST_CNY_PER_1M_TOKENS",
      0,
    ),
    outputCostCnyPerMillionTokens: readOptionalNonNegativeNumber(
      "MODEL_OUTPUT_COST_CNY_PER_1M_TOKENS",
      0,
    ),
  });
  const database = getWorkerDatabaseConnection();
  const telemetry = new Telemetry(new JsonConsoleTelemetrySink());
  const model = new InstrumentedStructuredModel(
    baseModel,
    telemetry,
    new DatabaseUsageSink(database.db),
    modelName,
    () => telemetry.currentTraceId() ?? "unscoped",
  );
  const redis = getWorkerRedis();
  const researchCache = new ResearchCache(redis);
  const webSearch = new CachedWebSearch(
    createTavilyWebSearch(searchApiKey),
    researchCache,
    "tavily-v1",
  );
  const contentExtractor = new BoundedContentExtractor(
    new CachedWebPage(
      new BoundedWebPageFetcher({
        defaultTimeoutMs: searchTimeoutMs,
      }),
      researchCache,
      "bounded-fetcher-v1",
    ),
  );
  const researchTool = new WebResearchTool(webSearch, contentExtractor);
  const checkpointer = getWorkerAgentCheckpointer();
  const runs = new RunRepository(database.db);
  const evidenceStore = new EvidenceRepository(database.db);
  const reportStore = new ReportRepository(database.db);
  const progress = new ProgressPublisher(redis);
  const cancellation = new CancellationGuard(redis);

  const graph = createResearchGraph({
    model,
    researchTool,
    evidenceStore,
    reportStore,
    budgets,
    checkpointer,
    executionGuard: cancellation,
    operationTimeouts: {
      modelMs: modelTimeoutMs,
      searchMs: searchTimeoutMs,
    },
    telemetry,
    toolAudit: {
      async record(event) {
        console.log(
          JSON.stringify({
            level: event.phase === "failed" ? "error" : "info",
            event: "tool",
            ...event,
          }),
        );
      },
    },
  });

  return new AgentResearchWorkflow(
    runs,
    graph,
    progress,
    cancellation,
    budgets,
  );
};
