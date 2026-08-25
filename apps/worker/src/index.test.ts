import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const workflow = { kind: "workflow" };
  const processor = { kind: "processor" };
  const redis = { kind: "redis" };
  const database = { db: { kind: "database" } };
  const repository = { kind: "repository" };
  const progress = { kind: "progress" };
  const failureHandler = { handle: vi.fn().mockResolvedValue(undefined) };
  const eventHandlers = new Map<string, (...args: never[]) => unknown>();
  const worker = {
    on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
      eventHandlers.set(event, handler);
      return worker;
    }),
  };
  const runtime = {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    workflow,
    processor,
    redis,
    database,
    repository,
    progress,
    failureHandler,
    eventHandlers,
    worker,
    runtime,
    createAgentResearchWorkflow: vi.fn(() => workflow),
    createResearchRunProcessor: vi.fn(() => processor),
    getWorkerRedis: vi.fn(() => redis),
    closeWorkerRedis: vi.fn().mockResolvedValue(undefined),
    getWorkerDatabaseConnection: vi.fn(() => database),
    closeWorkerDatabaseConnection: vi.fn().mockResolvedValue(undefined),
    createResearchWorker: vi.fn(() => worker),
    WorkerRuntime: vi.fn(function MockWorkerRuntime() {
      return runtime;
    }),
    RunRepository: vi.fn(function MockRunRepository() {
      return repository;
    }),
    ProgressPublisher: vi.fn(function MockProgressPublisher() {
      return progress;
    }),
    ResearchRunFailureHandler: vi.fn(function MockFailureHandler() {
      return failureHandler;
    }),
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("@insightforge/db", () => ({
  RunRepository: mocks.RunRepository,
}));

vi.mock("./agent-workflow-provider", () => ({
  createAgentResearchWorkflow: mocks.createAgentResearchWorkflow,
}));

vi.mock("./run-processor-provider", () => ({
  createResearchRunProcessor: mocks.createResearchRunProcessor,
}));

vi.mock("./redis", () => ({
  getWorkerRedis: mocks.getWorkerRedis,
  closeWorkerRedis: mocks.closeWorkerRedis,
}));

vi.mock("./database", () => ({
  getWorkerDatabaseConnection: mocks.getWorkerDatabaseConnection,
  closeWorkerDatabaseConnection: mocks.closeWorkerDatabaseConnection,
}));

vi.mock("./research-worker", () => ({
  createResearchWorker: mocks.createResearchWorker,
}));

vi.mock("./worker-runtime", () => ({
  WorkerRuntime: mocks.WorkerRuntime,
}));

vi.mock("./progress-publisher", () => ({
  ProgressPublisher: mocks.ProgressPublisher,
}));

vi.mock("./run-failure-handler", () => ({
  ResearchRunFailureHandler: mocks.ResearchRunFailureHandler,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Worker entrypoint", () => {
  it("组装 Worker、注册事件与退出信号并等待就绪", async () => {
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers.set(event, listener as () => void);
      }
      return process;
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await import("./index");

    expect(mocks.createResearchRunProcessor).toHaveBeenCalledWith(
      mocks.workflow,
    );
    expect(mocks.createResearchWorker).toHaveBeenCalledWith(
      mocks.redis,
      mocks.processor,
    );
    expect(mocks.WorkerRuntime).toHaveBeenCalledWith({
      worker: mocks.worker,
      closeRedis: mocks.closeWorkerRedis,
      closeDatabase: mocks.closeWorkerDatabaseConnection,
    });
    expect(mocks.worker.on).toHaveBeenCalledWith(
      "failed",
      expect.any(Function),
    );
    expect(mocks.worker.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(signalHandlers.has("SIGINT")).toBe(true);
    expect(signalHandlers.has("SIGTERM")).toBe(true);
    expect(mocks.runtime.start).toHaveBeenCalledOnce();

    signalHandlers.get("SIGTERM")?.();
    await vi.waitFor(() => expect(mocks.runtime.close).toHaveBeenCalledOnce());
  });
});
