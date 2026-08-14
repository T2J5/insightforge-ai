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
});
