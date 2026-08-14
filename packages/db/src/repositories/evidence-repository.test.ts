import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EvidenceSchema, type Evidence } from "@insightforge/domain";
import { config } from "dotenv";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../client";
import { evidence as evidenceTable, users } from "../schema";
import { EvidenceRepository } from "./evidence-repository";
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
  maxConnections: 2,
});

const evidenceRepository = new EvidenceRepository(connection.db);

const runRepository = new RunRepository(connection.db);

const testOwnerId = "evidence-repository-test-user";

const testOwnerEmail = "evidence-repository-test@example.com";

/**
 * 创建属于 EvidenceRepository 测试用户的调研任务。
 */
const createTestRun = () => {
  return runRepository.create({
    ownerId: testOwnerId,
    company: "ByteDance",
    focus: "technology",
    depth: "quick",
  });
};

/**
 * 构造一条合法的网页证据。
 *
 * 使用 EvidenceSchema.parse() 可以确保测试数据本身
 * 符合 Domain 契约，避免因为 Fixture 写错而误判
 * Repository 存在问题。
 */
const createWebEvidence = (
  runId: string,
  overrides: Partial<Evidence> = {},
): Evidence => {
  return EvidenceSchema.parse({
    id: randomUUID(),
    runId,
    ownerId: testOwnerId,
    claim: "ByteDance operates multiple content platforms.",
    sourceType: "web",
    sourceUrl: "https://example.com/bytedance",
    sourceTitle: "ByteDance Company Profile",
    publisher: "Example Publisher",
    publishedAt: new Date("2026-01-01T08:00:00.000Z"),
    retrievedAt: new Date("2026-08-01T08:00:00.000Z"),
    quote: "ByteDance operates multiple content platforms around the world.",
    documentId: null,
    page: null,
    confidence: 0.9,
    contentHash: "a".repeat(64),
    ...overrides,
  });
};

describe.sequential("EvidenceRepository", () => {
  /**
   * 每个测试开始前只清理本测试拥有的数据。
   *
   * 删除 users 后，research_runs 和 evidence
   * 会通过外键的 ON DELETE CASCADE 自动删除。
   */
  beforeEach(async () => {
    await connection.db.delete(users).where(eq(users.id, testOwnerId));

    await connection.db.insert(users).values({
      id: testOwnerId,
      email: testOwnerEmail,
      name: "Evidence Repository Test",
    });
  });

  afterAll(async () => {
    await connection.db.delete(users).where(eq(users.id, testOwnerId));

    await connection.close();
  });

  it("inserts and returns a web evidence", async () => {
    const run = await createTestRun();

    const input = createWebEvidence(run.id);

    const saved = await evidenceRepository.upsert(input);

    expect(saved).toEqual(input);

    expect(typeof saved.confidence).toBe("number");

    expect(saved.retrievedAt).toBeInstanceOf(Date);
  });

  it("updates an existing evidence without changing its identity", async () => {
    const run = await createTestRun();

    const firstInput = createWebEvidence(run.id);

    const first = await evidenceRepository.upsert(firstInput);

    const secondInput = createWebEvidence(run.id, {
      id: randomUUID(),
      contentHash: firstInput.contentHash,
      claim: "ByteDance operates global content products.",
      quote: "The company operates global content products.",
      confidence: 0.75,
      retrievedAt: new Date("2026-08-02T08:00:00.000Z"),
    });

    const second = await evidenceRepository.upsert(secondInput);

    /**
     * 第二次输入带有新的ID，但发生唯一索引冲突后，
     * 数据库应当保留第一次插入的实体ID。
     */
    expect(second.id).toBe(first.id);

    expect(second).toMatchObject({
      claim: "ByteDance operates global content products.",
      quote: "The company operates global content products.",
      confidence: 0.75,
      retrievedAt: new Date("2026-08-02T08:00:00.000Z"),
    });

    const storedRows = await connection.db
      .select()
      .from(evidenceTable)
      .where(
        and(
          eq(evidenceTable.runId, run.id),
          eq(evidenceTable.contentHash, firstInput.contentHash),
        ),
      );

    expect(storedRows).toHaveLength(1);

    expect(storedRows[0]?.id).toBe(first.id);
  });

  it("allows the same content hash in different runs", async () => {
    const firstRun = await createTestRun();

    const secondRun = await createTestRun();

    const contentHash = "b".repeat(64);

    const first = await evidenceRepository.upsert(
      createWebEvidence(firstRun.id, {
        contentHash,
      }),
    );

    const second = await evidenceRepository.upsert(
      createWebEvidence(secondRun.id, {
        contentHash,
      }),
    );

    expect(first.id).not.toBe(second.id);

    expect(first.runId).toBe(firstRun.id);

    expect(second.runId).toBe(secondRun.id);
  });

  it("lists only evidence for the requested run in stable order", async () => {
    const requestedRun = await createTestRun();

    const otherRun = await createTestRun();

    const later = createWebEvidence(requestedRun.id, {
      contentHash: "c".repeat(64),
      retrievedAt: new Date("2026-08-03T08:00:00.000Z"),
    });

    const earlier = createWebEvidence(requestedRun.id, {
      contentHash: "d".repeat(64),
      retrievedAt: new Date("2026-08-01T08:00:00.000Z"),
    });

    const middle = createWebEvidence(requestedRun.id, {
      contentHash: "e".repeat(64),
      retrievedAt: new Date("2026-08-02T08:00:00.000Z"),
    });

    await evidenceRepository.upsert(later);

    await evidenceRepository.upsert(earlier);

    await evidenceRepository.upsert(middle);

    await evidenceRepository.upsert(
      createWebEvidence(otherRun.id, {
        contentHash: "f".repeat(64),
      }),
    );

    const result = await evidenceRepository.listForRun(requestedRun.id);

    expect(result.map((item) => item.contentHash)).toEqual([
      earlier.contentHash,
      middle.contentHash,
      later.contentHash,
    ]);

    expect(result.every((item) => item.runId === requestedRun.id)).toBe(true);
  });

  it("returns an empty array when a run has no evidence", async () => {
    const run = await createTestRun();

    const result = await evidenceRepository.listForRun(run.id);

    expect(result).toEqual([]);
  });
});
