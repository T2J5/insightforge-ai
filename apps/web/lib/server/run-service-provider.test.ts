import { RESEARCH_RUN_JOB, type ResearchRunJob } from "@insightforge/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CancellationStore, ResearchRunQueue } from "./run-service";
import { getRunService } from "./run-service-provider";

const mocks = vi.hoisted(() => ({
  getDatabaseConnection: vi.fn(),
  getResearchQueue: vi.fn(),
  getProducerRedis: vi.fn(),
  repositoryDatabases: [] as unknown[],
  runServiceArguments: [] as unknown[][],
}));

vi.mock("@insightforge/db", () => ({
  RunRepository: class MockRunRepository {
    constructor(database: unknown) {
      mocks.repositoryDatabases.push(database);
    }
  },
}));

vi.mock("./database", () => ({
  getDatabaseConnection: mocks.getDatabaseConnection,
}));

vi.mock("./research-queue", () => ({
  getResearchQueue: mocks.getResearchQueue,
}));

vi.mock("./redis", () => ({
  getProducerRedis: mocks.getProducerRedis,
}));

vi.mock("./run-service", () => ({
  RunService: class MockRunService {
    constructor(...args: unknown[]) {
      mocks.runServiceArguments.push(args);
    }
  },
}));

type TestRunServiceGlobal = typeof globalThis & {
  __insightforgeRunService?: unknown;
};

const runServiceGlobal = globalThis as TestRunServiceGlobal;

beforeEach(() => {
  delete runServiceGlobal.__insightforgeRunService;
  mocks.getDatabaseConnection.mockReset();
  mocks.getResearchQueue.mockReset();
  mocks.getProducerRedis.mockReset();
  mocks.repositoryDatabases.length = 0;
  mocks.runServiceArguments.length = 0;
});

describe("getRunService", () => {
  it("组装Repository、BullMQ和Redis适配器并复用Service", async () => {
    const database = { name: "database" };
    const queueAdd = vi.fn().mockResolvedValue({ id: "job-1" });
    const redisSet = vi.fn().mockResolvedValue("OK");

    mocks.getDatabaseConnection.mockReturnValue({ db: database });
    mocks.getResearchQueue.mockReturnValue({ add: queueAdd });
    mocks.getProducerRedis.mockReturnValue({ set: redisSet });

    const first = getRunService();
    const second = getRunService();

    expect(second).toBe(first);
    expect(mocks.getDatabaseConnection).toHaveBeenCalledTimes(1);
    expect(mocks.getResearchQueue).toHaveBeenCalledTimes(1);
    expect(mocks.getProducerRedis).toHaveBeenCalledTimes(1);
    expect(mocks.repositoryDatabases).toEqual([database]);
    expect(mocks.runServiceArguments).toHaveLength(1);

    const argumentsForService = mocks.runServiceArguments[0];

    expect(argumentsForService).toBeDefined();

    const queueAdapter = argumentsForService?.[1] as ResearchRunQueue;
    const cancellationStore = argumentsForService?.[2] as CancellationStore;
    const jobData: ResearchRunJob = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
    };

    await queueAdapter.add(RESEARCH_RUN_JOB, jobData, {
      jobId: jobData.runId,
    });

    expect(queueAdd).toHaveBeenCalledWith(RESEARCH_RUN_JOB, jobData, {
      jobId: jobData.runId,
    });

    await cancellationStore.set(
      `run:${jobData.runId}:cancelled`,
      "1",
      "EX",
      86_400,
    );

    expect(redisSet).toHaveBeenCalledWith(
      `run:${jobData.runId}:cancelled`,
      "1",
      "EX",
      86_400,
    );
  });
});
