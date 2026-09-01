import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  documentChunks,
  documents,
  researchRuns,
  users,
} from "@insightforge/db";
import { config } from "dotenv";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresDocumentStore } from "./postgres-document-store";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
config({ path: resolve(currentDirectory, "../../../.env") });
const databaseUrl = process.env.DATABASE_TEST_URL;
if (!databaseUrl)
  throw new Error("DATABASE_TEST_URL environment variable is not defined");

const connection = createDatabase(databaseUrl, { maxConnections: 2 });
const store = new PostgresDocumentStore(connection.db);
const ownerA = "retrieval-store-user-a";
const ownerB = "retrieval-store-user-b";

const vector = (first: number): number[] => [
  first,
  ...Array.from({ length: 1_535 }, () => 0),
];

const insertDocument = async (ownerId: string, content: string) => {
  const runId = randomUUID();
  await connection.db.insert(researchRuns).values({
    id: runId,
    ownerId,
    company: "Test Company",
    focus: "technology",
    depth: "quick",
  });
  const documentId = randomUUID();
  await connection.db.insert(documents).values({
    id: documentId,
    runId,
    ownerId,
    title: "Private Strategy",
    originalName: "strategy.txt",
    documentType: "text",
    status: "ready",
    errorCode: null,
    sourceUrl: null,
    mimeType: "text/plain",
    fileSize: content.length,
    contentHash: randomUUID().replaceAll("-", "").padEnd(64, "a").slice(0, 64),
    storageKey: `documents/${documentId}.text`,
  });
  const chunkId = randomUUID();
  await connection.db.insert(documentChunks).values({
    id: chunkId,
    documentId,
    ownerId,
    chunkIndex: 0,
    content,
    tokenCount: 5,
    metadata: { pageStart: 1, pageEnd: 1, headingPath: ["Strategy"] },
    embedding: vector(1),
  });
  return { runId, documentId, chunkId };
};

describe.sequential("PostgresDocumentStore", () => {
  beforeEach(async () => {
    await connection.db.delete(users).where(eq(users.id, ownerA));
    await connection.db.delete(users).where(eq(users.id, ownerB));
    await connection.db.insert(users).values([
      { id: ownerA, email: null },
      { id: ownerB, email: null },
    ]);
  });

  afterAll(async () => {
    await connection.db.delete(users).where(eq(users.id, ownerA));
    await connection.db.delete(users).where(eq(users.id, ownerB));
    await connection.close();
  });

  it("关键词和向量检索都强制执行 owner 与文档过滤", async () => {
    const own = await insertDocument(ownerA, "private acquisition strategy");
    const other = await insertDocument(ownerB, "private acquisition secret");

    const lexical = await store.lexicalSearch({
      ownerId: ownerA,
      documentIds: [],
      query: "acquisition",
      limit: 30,
    });
    const semantic = await store.vectorSearch({
      ownerId: ownerA,
      documentIds: [],
      embedding: vector(1),
      limit: 30,
    });
    expect(lexical.map((item) => item.documentId)).toEqual([own.documentId]);
    expect(semantic.map((item) => item.documentId)).toEqual([own.documentId]);
    await expect(
      store.lexicalSearch({
        ownerId: ownerA,
        documentIds: [other.documentId],
        query: "acquisition",
        limit: 30,
      }),
    ).resolves.toEqual([]);
  });

  it("同一文档可以复用到 Run，并按关联表统计上限", async () => {
    const own = await insertDocument(ownerA, "shared annual report");
    const secondRunId = randomUUID();
    await connection.db.insert(researchRuns).values({
      id: secondRunId,
      ownerId: ownerA,
      company: "Second Research",
      focus: "business",
      depth: "quick",
    });
    await store.attachToRun(own.documentId, secondRunId, ownerA);
    await store.attachToRun(own.documentId, secondRunId, ownerA);
    await expect(store.countForRun(secondRunId, ownerA)).resolves.toBe(1);
    await expect(
      store.attachToRun(own.documentId, secondRunId, ownerB),
    ).rejects.toThrow("DOCUMENT_NOT_ACCESSIBLE");
  });

  it("chunk 写入失败时事务回滚，不留下部分索引", async () => {
    const own = await insertDocument(ownerA, "existing searchable chunk");
    await expect(
      store.complete(own.documentId, ownerA, "Updated", [
        {
          chunkIndex: 0,
          content: "invalid vector chunk",
          tokenCount: 4,
          metadata: { pageStart: 1, pageEnd: 1, headingPath: [] },
          embedding: [1, 2],
        },
      ]),
    ).rejects.toThrow();
    const rows = await connection.db
      .select()
      .from(documentChunks)
      .where(
        and(
          eq(documentChunks.documentId, own.documentId),
          eq(documentChunks.ownerId, ownerA),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("existing searchable chunk");
  });
});
