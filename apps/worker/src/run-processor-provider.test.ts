import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const database = { db: { kind: "database" } };
  const redis = { kind: "redis" };
  const repository = { kind: "run-repository" };
  const cancellation = { kind: "cancellation-guard" };
  const progress = { kind: "progress-publisher" };
  const processor = { kind: "research-run-processor" };

  return {
    database,
    redis,
    repository,
    cancellation,
    progress,
    processor,
    getWorkerDatabaseConnection: vi.fn(() => database),
    getWorkerRedis: vi.fn(() => redis),
    RunRepository: vi.fn(function MockRunRepository() {
      return repository;
    }),
    CancellationGuard: vi.fn(function MockCancellationGuard() {
      return cancellation;
    }),
    ProgressPublisher: vi.fn(function MockProgressPublisher() {
      return progress;
    }),
    ResearchRunProcessor: vi.fn(function MockResearchRunProcessor() {
      return processor;
    }),
  };
});

vi.mock("@insightforge/db", () => ({
  RunRepository: mocks.RunRepository,
}));

vi.mock("./database", () => ({
  getWorkerDatabaseConnection: mocks.getWorkerDatabaseConnection,
}));

vi.mock("./redis", () => ({
  getWorkerRedis: mocks.getWorkerRedis,
}));

vi.mock("./cancellation", () => ({
  CancellationGuard: mocks.CancellationGuard,
}));

vi.mock("./progress-publisher", () => ({
  ProgressPublisher: mocks.ProgressPublisher,
}));

vi.mock("./processors/research-run", () => ({
  ResearchRunProcessor: mocks.ResearchRunProcessor,
}));

import { createResearchRunProcessor } from "./run-processor-provider";

describe("createResearchRunProcessor", () => {
  it("使用共享基础设施和调用方Workflow组装Processor", () => {
    const workflow = {
      run: vi.fn().mockResolvedValue(undefined),
    };

    const result = createResearchRunProcessor(workflow);

    expect(result).toBe(mocks.processor);
    expect(mocks.getWorkerDatabaseConnection).toHaveBeenCalledOnce();
    expect(mocks.getWorkerRedis).toHaveBeenCalledOnce();
    expect(mocks.RunRepository).toHaveBeenCalledWith(mocks.database.db);
    expect(mocks.CancellationGuard).toHaveBeenCalledWith(mocks.redis);
    expect(mocks.ProgressPublisher).toHaveBeenCalledWith(mocks.redis);
    expect(mocks.ResearchRunProcessor).toHaveBeenCalledWith(
      mocks.repository,
      workflow,
      mocks.progress,
      mocks.cancellation,
    );
  });
});
