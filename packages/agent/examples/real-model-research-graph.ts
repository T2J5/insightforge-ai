import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import {
  createOpenAiStructuredModel,
  createResearchGraph,
  createTavilyContentExtractor,
  createTavilyWebSearch,
  WebResearchTool,
} from "../src";

loadEnvFile(resolve(import.meta.dirname, "../../../.env"));

const requireEnvironmentVariable = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
};

const readOptionalNonNegativeNumber = (name: string, fallback: number) => {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Environment variable ${name} must be a non-negative number`,
    );
  }
  return value;
};

const readOptionalPositiveInteger = (name: string, fallback: number) => {
  const value = readOptionalNonNegativeNumber(name, fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return value;
};

const main = async () => {
  const model = createOpenAiStructuredModel({
    apiKey: requireEnvironmentVariable("MODEL_API_KEY"),
    modelName: process.env.MODEL_NAME?.trim() || "gpt-5.6-luna",
    baseUrl: process.env.MODEL_BASE_URL,
    maxRetries: readOptionalPositiveInteger("MODEL_MAX_RETRIES", 2),
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
  const searchApiKey = requireEnvironmentVariable("SEARCH_API_KEY");
  const webSearch = createTavilyWebSearch(searchApiKey);
  const contentExtractor = createTavilyContentExtractor(searchApiKey);
  const researchTool = new WebResearchTool(webSearch, contentExtractor);

  const graph = createResearchGraph({ model, researchTool });

  const stream = await graph.stream(
    {
      company: "ByteDance",
      focus: "technology",
      depth: "quick",
    },
    {
      streamMode: "updates",
    },
  );
  console.log("\n=== 真实模型 Agent 执行过程 ===\n");
  for await (const update of stream) {
    for (const [nodeName, nodeUpdate] of Object.entries(update)) {
      console.log(`Node: ${nodeName}`);
      console.dir(nodeUpdate, { depth: null, colors: true });
      console.log();
    }
  }
};

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
