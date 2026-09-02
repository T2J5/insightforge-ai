import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const model = { kind: "model" };
  const webSearch = { kind: "web-search" };
  const contentExtractor = { kind: "content-extractor" };
  const pageFetcher = { kind: "page-fetcher" };
  const researchTool = { kind: "research-tool" };
  const graph = { kind: "graph" };
  const database = { db: { kind: "database" } };
  const redis = { kind: "redis" };
  const runs = { kind: "runs" };
  const evidenceStore = { kind: "evidence-store" };
  const reportStore = { kind: "report-store" };
  const progress = { kind: "progress" };
  const cancellation = { kind: "cancellation" };
  const checkpointer = { kind: "checkpointer" };
  const workflow = { kind: "workflow" };
  const budgets = {
    quick: {
      maxSearchCount: 12,
      maxTokenUsage: 80_000,
      maxEstimatedCostCny: 5,
      maxDurationMs: 300_000,
    },
    deep: {
      maxSearchCount: 30,
      maxTokenUsage: 200_000,
      maxEstimatedCostCny: 15,
      maxDurationMs: 900_000,
    },
  };

  return {
    model,
    webSearch,
    contentExtractor,
    pageFetcher,
    researchTool,
    graph,
    database,
    redis,
    runs,
    evidenceStore,
    reportStore,
    progress,
    cancellation,
    checkpointer,
    workflow,
    budgets,
    ResearchBudgetsSchema: { parse: vi.fn((value) => value) },
    createOpenAiStructuredModel: vi.fn(() => model),
    createTavilyWebSearch: vi.fn(() => webSearch),
    BoundedWebPageFetcher: vi.fn(function MockBoundedWebPageFetcher() {
      return pageFetcher;
    }),
    BoundedContentExtractor: vi.fn(function MockBoundedContentExtractor() {
      return contentExtractor;
    }),
    WebResearchTool: vi.fn(function MockWebResearchTool() {
      return researchTool;
    }),
    createResearchGraph: vi.fn(() => graph),
    getWorkerDatabaseConnection: vi.fn(() => database),
    getWorkerRedis: vi.fn(() => redis),
    getWorkerAgentCheckpointer: vi.fn(() => checkpointer),
    RunRepository: vi.fn(function MockRunRepository() {
      return runs;
    }),
    EvidenceRepository: vi.fn(function MockEvidenceRepository() {
      return evidenceStore;
    }),
    ReportRepository: vi.fn(function MockReportRepository() {
      return reportStore;
    }),
    ProgressPublisher: vi.fn(function MockProgressPublisher() {
      return progress;
    }),
    CancellationGuard: vi.fn(function MockCancellationGuard() {
      return cancellation;
    }),
    AgentResearchWorkflow: vi.fn(function MockAgentResearchWorkflow() {
      return workflow;
    }),
  };
});

vi.mock("@insightforge/agent", () => ({
  createOpenAiStructuredModel: mocks.createOpenAiStructuredModel,
  createTavilyWebSearch: mocks.createTavilyWebSearch,
  BoundedWebPageFetcher: mocks.BoundedWebPageFetcher,
  BoundedContentExtractor: mocks.BoundedContentExtractor,
  WebResearchTool: mocks.WebResearchTool,
  createResearchGraph: mocks.createResearchGraph,
  ResearchBudgetsSchema: mocks.ResearchBudgetsSchema,
  DEFAULT_RESEARCH_BUDGETS: mocks.budgets,
}));

vi.mock("@insightforge/db", () => ({
  RunRepository: mocks.RunRepository,
  EvidenceRepository: mocks.EvidenceRepository,
  ReportRepository: mocks.ReportRepository,
}));

vi.mock("./database", () => ({
  getWorkerDatabaseConnection: mocks.getWorkerDatabaseConnection,
}));

vi.mock("./redis", () => ({
  getWorkerRedis: mocks.getWorkerRedis,
}));

vi.mock("./checkpointer", () => ({
  getWorkerAgentCheckpointer: mocks.getWorkerAgentCheckpointer,
}));

vi.mock("./progress-publisher", () => ({
  ProgressPublisher: mocks.ProgressPublisher,
}));

vi.mock("./cancellation", () => ({
  CancellationGuard: mocks.CancellationGuard,
}));

vi.mock("./agent-workflow", () => ({
  AgentResearchWorkflow: mocks.AgentResearchWorkflow,
}));

import { createAgentResearchWorkflow } from "./agent-workflow-provider";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MODEL_API_KEY", "model-key");
  vi.stubEnv("SEARCH_API_KEY", "search-key");
  vi.stubEnv("MODEL_NAME", "test-model");
  vi.stubEnv("MODEL_BASE_URL", "https://model.example.com/v1");
  vi.stubEnv("MODEL_MAX_RETRIES", "2");
  vi.stubEnv("MODEL_TIMEOUT_MS", "120000");
  vi.stubEnv("MODEL_MAX_OUTPUT_TOKENS", "8000");
  vi.stubEnv("MODEL_INPUT_COST_CNY_PER_1M_TOKENS", "1.5");
  vi.stubEnv("MODEL_OUTPUT_COST_CNY_PER_1M_TOKENS", "6");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createAgentResearchWorkflow", () => {
  it.each([
    ["MODEL_API_KEY", "Environment variable MODEL_API_KEY is required"],
    ["SEARCH_API_KEY", "Environment variable SEARCH_API_KEY is required"],
  ])("缺少 %s 时在创建基础设施前失败", (name, message) => {
    vi.stubEnv(name, "");

    expect(() => createAgentResearchWorkflow()).toThrow(message);
    expect(mocks.getWorkerDatabaseConnection).not.toHaveBeenCalled();
    expect(mocks.getWorkerRedis).not.toHaveBeenCalled();
    expect(mocks.getWorkerAgentCheckpointer).not.toHaveBeenCalled();
  });

  it("使用环境变量创建模型、搜索工具、Graph 和 Workflow", () => {
    expect(createAgentResearchWorkflow()).toBe(mocks.workflow);

    expect(mocks.createOpenAiStructuredModel).toHaveBeenCalledWith({
      apiKey: "model-key",
      modelName: "test-model",
      baseUrl: "https://model.example.com/v1",
      maxRetries: 2,
      timeoutMs: 120_000,
      maxOutputTokens: 8_000,
      inputCostCnyPerMillionTokens: 1.5,
      outputCostCnyPerMillionTokens: 6,
    });
    expect(mocks.WebResearchTool).toHaveBeenCalledWith(
      mocks.webSearch,
      mocks.contentExtractor,
    );
    expect(mocks.BoundedWebPageFetcher).toHaveBeenCalledWith({
      defaultTimeoutMs: 30_000,
    });
    expect(mocks.BoundedContentExtractor).toHaveBeenCalledWith(
      mocks.pageFetcher,
    );
    expect(mocks.createResearchGraph).toHaveBeenCalledWith({
      model: mocks.model,
      researchTool: mocks.researchTool,
      evidenceStore: mocks.evidenceStore,
      reportStore: mocks.reportStore,
      budgets: mocks.budgets,
      checkpointer: mocks.checkpointer,
      executionGuard: mocks.cancellation,
      operationTimeouts: {
        modelMs: 120_000,
        searchMs: 30_000,
      },
    });
    expect(mocks.AgentResearchWorkflow).toHaveBeenCalledWith(
      mocks.runs,
      mocks.graph,
      mocks.progress,
      mocks.cancellation,
      mocks.budgets,
    );
  });

  it("MODEL_MAX_RETRIES 允许为 0", () => {
    vi.stubEnv("MODEL_MAX_RETRIES", "0");

    expect(() => createAgentResearchWorkflow()).not.toThrow();
    expect(mocks.createOpenAiStructuredModel).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0 }),
    );
  });

  it("搜索和 Token 预算允许显式配置为 0", () => {
    vi.stubEnv("AGENT_QUICK_MAX_SEARCHES", "0");
    vi.stubEnv("AGENT_QUICK_MAX_TOKENS", "0");

    expect(() => createAgentResearchWorkflow()).not.toThrow();
    expect(mocks.createResearchGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        budgets: expect.objectContaining({
          quick: expect.objectContaining({
            maxSearchCount: 0,
            maxTokenUsage: 0,
          }),
        }),
      }),
    );
  });

  it.each([
    ["MODEL_MAX_RETRIES", "6"],
    ["MODEL_MAX_RETRIES", "1.5"],
    ["MODEL_TIMEOUT_MS", "0"],
    ["MODEL_MAX_OUTPUT_TOKENS", "0"],
    ["MODEL_INPUT_COST_CNY_PER_1M_TOKENS", "-1"],
  ])("拒绝非法环境变量 %s=%s", (name, value) => {
    vi.stubEnv(name, value);

    expect(() => createAgentResearchWorkflow()).toThrow();
    expect(mocks.getWorkerDatabaseConnection).not.toHaveBeenCalled();
  });
});
