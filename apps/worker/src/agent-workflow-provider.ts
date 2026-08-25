import {
  createOpenAiStructuredModel,
  createTavilyContentExtractor,
  createTavilyWebSearch,
  WebResearchTool,
  createResearchGraph,
} from "@insightforge/agent";
import { AgentResearchWorkflow } from "./agent-workflow";
import { getWorkerDatabaseConnection } from "./database";
import { getWorkerRedis } from "./redis";
import { RunRepository } from "@insightforge/db";
import { ProgressPublisher } from "./progress-publisher";
import { CancellationGuard } from "./cancellation";

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
  /**
   * 先校验外部服务配置。
   *
   * 如果配置错误，应在 Worker 启动阶段失败，
   * 而不是等到消费第一个任务时才失败。
   */
  const modelApiKey = requireEnvironmentVariable("MODEL_API_KEY");
  const searchApiKey = requireEnvironmentVariable("SEARCH_API_KEY");
  const model = createOpenAiStructuredModel({
    apiKey: modelApiKey,
    modelName: process.env.MODEL_NAME?.trim() || "gpt-5.6-luna",
    baseUrl: process.env.MODEL_BASE_URL?.trim() || undefined,
    maxRetries: readOptionalRetryCount("MODEL_MAX_RETRIES", 2),
    timeoutMs: readOptionalPositiveInteger("MODEL_TIMEOUT_MS", 120_000),
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
  const webSearch = createTavilyWebSearch(searchApiKey);
  const contentExtractor = createTavilyContentExtractor(searchApiKey);
  const researchTool = new WebResearchTool(webSearch, contentExtractor);
  const graph = createResearchGraph({ model, researchTool });
  const database = getWorkerDatabaseConnection();
  const redis = getWorkerRedis();
  const runs = new RunRepository(database.db);
  const progress = new ProgressPublisher(redis);
  const cancellation = new CancellationGuard(redis);
  return new AgentResearchWorkflow(runs, graph, progress, cancellation);
};
