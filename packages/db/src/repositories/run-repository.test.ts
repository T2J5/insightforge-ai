import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../client";
import { EvidenceRepository } from "./evidence-repository";
import { ReportRepository } from "./report-repository";
import { RunRepository } from "./run-repository";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://insightforge:insightforge@localhost:54329/insightforge";

describe("RunRepository", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const database = createDatabase(pool);
  const repository = new RunRepository(database);
  const evidenceRepository = new EvidenceRepository(database);
  const reportRepository = new ReportRepository(database);

  beforeAll(async () => {
    const migrationPath = fileURLToPath(
      new URL("../migrations/0001_initial.sql", import.meta.url),
    );
    await pool.query(await readFile(migrationPath, "utf8"));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates a queued run that can be retrieved", async () => {
    const run = await repository.create({
      ownerId: "user-create",
      company: "ByteDance",
      focus: "technology",
      depth: "quick",
    });

    await expect(repository.get(run.id)).resolves.toEqual(run);
    expect(run).toMatchObject({
      ownerId: "user-create",
      company: "ByteDance",
      status: "queued",
    });
  });

  it("changes status only when the current status matches", async () => {
    const run = await repository.create({
      ownerId: "user-transition",
      company: "ByteDance",
      focus: "technology",
      depth: "quick",
    });

    await expect(
      repository.transition(run.id, "queued", "running"),
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      repository.transition(run.id, "queued", "failed"),
    ).rejects.toThrow("RUN_STATUS_CONFLICT");
  });

  it("replaces a checkpoint with the same key", async () => {
    const run = await repository.create({
      ownerId: "user-checkpoint",
      company: "ByteDance",
      focus: "technology",
      depth: "quick",
    });

    await repository.saveCheckpoint(run.id, {
      checkpointKey: "planner",
      state: { completedQuestionIds: [] },
    });
    const saved = await repository.saveCheckpoint(run.id, {
      checkpointKey: "planner",
      state: { completedQuestionIds: ["question-1"] },
    });

    expect(saved).toMatchObject({
      runId: run.id,
      checkpointKey: "planner",
      state: { completedQuestionIds: ["question-1"] },
    });
  });

  it("upserts evidence by run and content hash", async () => {
    const run = await repository.create({
      ownerId: "user-evidence",
      company: "ByteDance",
      focus: "technology",
      depth: "quick",
    });
    const originalId = randomUUID();
    const retrievedAt = new Date("2026-08-01T00:00:00.000Z");

    await evidenceRepository.upsert({
      id: originalId,
      runId: run.id,
      ownerId: run.ownerId,
      claim: "ByteDance develops AI products.",
      sourceType: "web",
      sourceUrl: "https://example.com/bytedance",
      sourceTitle: "ByteDance overview",
      publisher: "Example Publisher",
      publishedAt: null,
      retrievedAt,
      quote: "ByteDance develops AI products.",
      documentId: null,
      page: null,
      confidence: 0.8,
      contentHash: "same-evidence",
    });
    const updated = await evidenceRepository.upsert({
      id: randomUUID(),
      runId: run.id,
      ownerId: run.ownerId,
      claim: "ByteDance develops multiple AI products.",
      sourceType: "web",
      sourceUrl: "https://example.com/bytedance",
      sourceTitle: "ByteDance overview",
      publisher: "Example Publisher",
      publishedAt: null,
      retrievedAt,
      quote: "ByteDance develops multiple AI products.",
      documentId: null,
      page: null,
      confidence: 0.9,
      contentHash: "same-evidence",
    });

    await expect(evidenceRepository.listForRun(run.id)).resolves.toEqual([
      updated,
    ]);
    expect(updated).toMatchObject({
      id: originalId,
      claim: "ByteDance develops multiple AI products.",
      confidence: 0.9,
    });
  });

  it("returns only the latest published report version", async () => {
    const run = await repository.create({
      ownerId: "user-report",
      company: "ByteDance",
      focus: "comprehensive",
      depth: "quick",
    });
    const reportId = randomUUID();

    const draft = await reportRepository.createVersion({
      reportId,
      runId: run.id,
      ownerId: run.ownerId,
      content: { title: "Draft" },
      status: "draft",
      qualityWarning: null,
    });
    expect(draft.version).toBe(1);
    await expect(reportRepository.getPublished(reportId)).resolves.toBeNull();

    const published = await reportRepository.createVersion({
      reportId,
      runId: run.id,
      ownerId: run.ownerId,
      content: { title: "Published" },
      status: "published",
      qualityWarning: null,
    });

    expect(published).toMatchObject({
      reportId,
      version: 2,
      content: { title: "Published" },
      status: "published",
    });
    await expect(reportRepository.getPublished(reportId)).resolves.toEqual(
      published,
    );
  });
});
