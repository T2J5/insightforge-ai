import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../client";
import { runCheckpoints, users } from "../schema";
import { RunRepository } from "./run-repository";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));

config({
  path: resolve(currentDirectory, "../../../../.env"),
});

const databaseTestUrl = process.env.DATABASE_TEST_URL;

if (!databaseTestUrl) {
  throw new Error("DATABASE_TEST_URL environment variable is not defined");
}

const connection = createDatabase(databaseTestUrl, {
  maxConnections: 1,
});

const repository = new RunRepository(connection.db);

const testOwnerId = "run-repository-test-user";

const testOwnerEmail = "run-repository-test@example.com";

/**
 * 创建一条测试调研任务。
 *
 * 每个测试都通过这个函数创建自己的任务，
 * 避免测试之间共享 runId。
 */
const createTestRun = () => {
  return repository.create({
    ownerId: testOwnerId,
    company: "ByteDance",
    focus: "technology",
    depth: "quick",
  });
};

describe.sequential("RunRepository", () => {
  /**
   * 删除固定测试用户时，
   * PostgreSQL 会根据 ON DELETE CASCADE
   * 自动删除该用户关联的调研任务。
   */
  beforeEach(async () => {
    await connection.db.delete(users).where(eq(users.id, testOwnerId));

    await connection.db.insert(users).values({
      id: testOwnerId,
      email: testOwnerEmail,
      name: "Run Repository Test",
    });
  });

  afterAll(async () => {
    await connection.db.delete(users).where(eq(users.id, testOwnerId));

    await connection.close();
  });

  it("creates a research run with database defaults", async () => {
    const run = await repository.create({
      ownerId: testOwnerId,
      company: " ByteDance ",
      focus: "technology",
      depth: "quick",
    });

    expect(run).toMatchObject({
      ownerId: testOwnerId,
      company: "ByteDance",
      focus: "technology",
      depth: "quick",
      status: "queued",
      tokenUsage: 0,
      estimatedCostCny: 0,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });

    expect(run.id).toEqual(expect.any(String));
  });

  it("首次匿名用户创建Run时在同一事务中自动创建用户", async () => {
    const anonymousOwnerId = `anonymous:${randomUUID()}`;

    try {
      const run = await repository.create({
        ownerId: anonymousOwnerId,
        company: "OpenAI",
        focus: "technology",
        depth: "quick",
      });

      const [storedUser] = await connection.db
        .select()
        .from(users)
        .where(eq(users.id, anonymousOwnerId))
        .limit(1);

      expect(storedUser).toMatchObject({
        id: anonymousOwnerId,
        email: null,
        name: null,
      });
      expect(run.ownerId).toBe(anonymousOwnerId);
      expect(await repository.get(run.id)).toEqual(run);
    } finally {
      await connection.db.delete(users).where(eq(users.id, anonymousOwnerId));
    }
  });

  it("gets an existing research run", async () => {
    const created = await createTestRun();

    const found = await repository.get(created.id);

    expect(found).toEqual(created);
  });

  it("returns null when a run does not exist", async () => {
    const found = await repository.get("00000000-0000-4000-8000-000000000000");

    expect(found).toBeNull();
  });

  it("changes status only when the current status matches", async () => {
    const run = await createTestRun();

    const running = await repository.transition(run.id, "queued", "running");

    expect(running.status).toBe("running");

    await expect(
      repository.transition(run.id, "queued", "failed"),
    ).rejects.toThrow("RUN_STATUS_CONFLICT");

    const stored = await repository.get(run.id);

    expect(stored?.status).toBe("running");
  });

  it("原子完成 running 任务并持久化用量", async () => {
    const run = await createTestRun();
    await repository.transition(run.id, "queued", "running");

    const completed = await repository.complete(run.id, {
      tokenUsage: 59068,
      estimatedCostCny: 0.123456,
    });

    expect(completed).toMatchObject({
      status: "completed",
      tokenUsage: 59068,
      estimatedCostCny: 0.123456,
    });
    expect(await repository.get(run.id)).toMatchObject({
      status: "completed",
      tokenUsage: 59068,
      estimatedCostCny: 0.123456,
    });
  });

  it("拒绝完成非 running 状态的任务且不写入用量", async () => {
    const run = await createTestRun();

    await expect(
      repository.complete(run.id, {
        tokenUsage: 100,
        estimatedCostCny: 0.1,
      }),
    ).rejects.toThrow("RUN_STATUS_CONFLICT");

    expect(await repository.get(run.id)).toMatchObject({
      status: "queued",
      tokenUsage: 0,
      estimatedCostCny: 0,
    });
  });

  it("upserts a checkpoint by run and checkpoint key", async () => {
    const run = await createTestRun();

    const first = await repository.saveCheckpoint(run.id, {
      checkpointKey: "planner",
      state: {
        searchCount: 1,
      },
    });

    const second = await repository.saveCheckpoint(run.id, {
      checkpointKey: "planner",
      state: {
        searchCount: 2,
        completed: true,
      },
    });

    expect(second.id).toBe(first.id);

    expect(second.state).toEqual({
      searchCount: 2,
      completed: true,
    });

    const storedCheckpoints = await connection.db
      .select()
      .from(runCheckpoints)
      .where(
        and(
          eq(runCheckpoints.runId, run.id),
          eq(runCheckpoints.checkpointKey, "planner"),
        ),
      );

    expect(storedCheckpoints).toHaveLength(1);

    expect(storedCheckpoints[0]?.state).toEqual({
      searchCount: 2,
      completed: true,
    });
  });

  it("gets a checkpoint and normalizes its key", async () => {
    const run = await createTestRun();
    const saved = await repository.saveCheckpoint(run.id, {
      checkpointKey: "request",
      state: {
        documentIds: [],
        source: "api",
      },
    });

    const found = await repository.getCheckpoint(run.id, " request ");

    expect(found).toEqual(saved);
  });

  it("returns null when a checkpoint does not exist", async () => {
    const run = await createTestRun();

    const found = await repository.getCheckpoint(run.id, "request");

    expect(found).toBeNull();
  });

  it("isolates checkpoints by both run and checkpoint key", async () => {
    const firstRun = await createTestRun();
    const secondRun = await createTestRun();

    await repository.saveCheckpoint(firstRun.id, {
      checkpointKey: "request",
      state: { marker: "first-request" },
    });
    await repository.saveCheckpoint(firstRun.id, {
      checkpointKey: "planner",
      state: { marker: "first-planner" },
    });
    await repository.saveCheckpoint(secondRun.id, {
      checkpointKey: "request",
      state: { marker: "second-request" },
    });

    const firstRequest = await repository.getCheckpoint(firstRun.id, "request");
    const firstPlanner = await repository.getCheckpoint(firstRun.id, "planner");
    const secondRequest = await repository.getCheckpoint(
      secondRun.id,
      "request",
    );

    expect(firstRequest?.state).toEqual({ marker: "first-request" });
    expect(firstPlanner?.state).toEqual({ marker: "first-planner" });
    expect(secondRequest?.state).toEqual({ marker: "second-request" });
  });

  it.each([
    ["空字符串", "", "RUN_CHECKPOINT_KEY_REQUIRED"],
    ["空白字符串", "   ", "RUN_CHECKPOINT_KEY_REQUIRED"],
    ["超过128字符", "a".repeat(129), "RUN_CHECKPOINT_KEY_INVALID"],
  ])("rejects %s checkpoint key", async (_case, checkpointKey, errorCode) => {
    const run = await createTestRun();

    await expect(
      repository.getCheckpoint(run.id, checkpointKey),
    ).rejects.toThrow(errorCode);
  });
});
