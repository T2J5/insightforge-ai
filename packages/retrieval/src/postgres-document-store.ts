import type { Database } from "@insightforge/db";
import { documentChunks, documents, runDocuments } from "@insightforge/db";
import type {
  DocumentStatus,
  SupportedDocumentType,
} from "@insightforge/domain";
import {
  and,
  cosineDistance,
  desc,
  eq,
  inArray,
  count,
  sql,
} from "drizzle-orm";

import type { DocumentChunkDraft } from "./chunk";
import type { DocumentIngestStore, StoredDocument } from "./ingest";
import type { RetrievalCandidate, RetrievalStore } from "./search";

const toStoredDocument = (
  row: typeof documents.$inferSelect,
): StoredDocument => ({
  id: row.id,
  runId: row.runId,
  ownerId: row.ownerId,
  title: row.title,
  originalName: row.originalName,
  type: row.documentType,
  mimeType: row.mimeType,
  fileSize: row.fileSize,
  contentHash: row.contentHash,
  storageKey: row.storageKey,
  status: row.status,
  errorCode: row.errorCode,
});

export class PostgresDocumentStore
  implements DocumentIngestStore, RetrievalStore
{
  constructor(private readonly db: Database) {}

  async findByOwnerHash(ownerId: string, contentHash: string) {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.ownerId, ownerId),
          eq(documents.contentHash, contentHash),
        ),
      )
      .limit(1);
    return row ? toStoredDocument(row) : null;
  }

  async createPending(input: {
    runId: string;
    ownerId: string;
    title: string;
    originalName: string;
    type: SupportedDocumentType;
    mimeType: string;
    fileSize: number;
    contentHash: string;
    storageKey: string;
  }): Promise<StoredDocument> {
    const [inserted] = await this.db
      .insert(documents)
      .values({
        runId: input.runId,
        ownerId: input.ownerId,
        title: input.title,
        originalName: input.originalName,
        documentType: input.type,
        mimeType: input.mimeType,
        fileSize: input.fileSize,
        contentHash: input.contentHash,
        storageKey: input.storageKey,
        status: "pending",
        sourceUrl: null,
        errorCode: null,
      })
      .onConflictDoNothing({
        target: [documents.ownerId, documents.contentHash],
      })
      .returning();
    if (inserted) return toStoredDocument(inserted);
    const existing = await this.findByOwnerHash(
      input.ownerId,
      input.contentHash,
    );
    if (!existing) throw new Error("DOCUMENT_CREATE_FAILED");
    return existing;
  }

  async getOwned(
    documentId: string,
    ownerId: string,
  ): Promise<StoredDocument | null> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.ownerId, ownerId)))
      .limit(1);
    return row ? toStoredDocument(row) : null;
  }

  async attachToRun(
    documentId: string,
    runId: string,
    ownerId: string,
  ): Promise<void> {
    const document = await this.getOwned(documentId, ownerId);
    if (!document) throw new Error("DOCUMENT_NOT_ACCESSIBLE");
    await this.db
      .insert(runDocuments)
      .values({ documentId, runId, ownerId })
      .onConflictDoNothing({
        target: [runDocuments.runId, runDocuments.documentId],
      });
  }

  async countForRun(runId: string, ownerId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(runDocuments)
      .where(
        and(eq(runDocuments.runId, runId), eq(runDocuments.ownerId, ownerId)),
      );
    return Number(row?.value ?? 0);
  }

  async setStatus(
    documentId: string,
    ownerId: string,
    status: DocumentStatus,
    errorCode: string | null,
  ): Promise<void> {
    await this.db
      .update(documents)
      .set({ status, errorCode })
      .where(and(eq(documents.id, documentId), eq(documents.ownerId, ownerId)));
  }

  async complete(
    documentId: string,
    ownerId: string,
    title: string,
    chunks: Array<DocumentChunkDraft & { embedding: number[] }>,
  ): Promise<void> {
    /**
     * Chunk 集合与 ready 状态必须成为同一个数据库事实。
     * 任一步失败都会回滚，检索不会读到半成品索引。
     */
    await this.db.transaction(async (transaction) => {
      await transaction
        .delete(documentChunks)
        .where(
          and(
            eq(documentChunks.documentId, documentId),
            eq(documentChunks.ownerId, ownerId),
          ),
        );
      await transaction.insert(documentChunks).values(
        chunks.map((chunk) => ({
          documentId,
          ownerId,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          metadata: chunk.metadata,
          embedding: chunk.embedding,
        })),
      );
      await transaction
        .update(documents)
        .set({ title, status: "ready", errorCode: null })
        .where(
          and(eq(documents.id, documentId), eq(documents.ownerId, ownerId)),
        );
    });
  }

  async lexicalSearch(input: {
    ownerId: string;
    documentIds: string[];
    query: string;
    limit: number;
  }): Promise<RetrievalCandidate[]> {
    const score = sql<number>`ts_rank_cd(to_tsvector('simple', ${documentChunks.content}), plainto_tsquery('simple', ${input.query}))`;
    /** owner 和 ready 过滤在 SQL 层执行，而不是查询后在内存中补救。 */
    const filters = [
      eq(documentChunks.ownerId, input.ownerId),
      eq(documents.status, "ready"),
      sql`to_tsvector('simple', ${documentChunks.content}) @@ plainto_tsquery('simple', ${input.query})`,
    ];
    if (input.documentIds.length > 0) {
      filters.push(inArray(documentChunks.documentId, input.documentIds));
    }
    const rows = await this.db
      .select({
        id: documentChunks.id,
        documentId: documentChunks.documentId,
        title: documents.title,
        content: documentChunks.content,
        metadata: documentChunks.metadata,
        score,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(and(...filters))
      .orderBy(desc(score), documentChunks.id)
      .limit(input.limit);
    return rows.map((row) => ({ ...row, score: Number(row.score) }));
  }

  async vectorSearch(input: {
    ownerId: string;
    documentIds: string[];
    embedding: number[];
    limit: number;
  }): Promise<RetrievalCandidate[]> {
    /** cosineDistance 越小越相似；对外用 1 - distance 表示越大越相关。 */
    const distance = cosineDistance(documentChunks.embedding, input.embedding);
    const score = sql<number>`1 - (${distance})`;
    const filters = [
      eq(documentChunks.ownerId, input.ownerId),
      eq(documents.status, "ready"),
    ];
    if (input.documentIds.length > 0) {
      filters.push(inArray(documentChunks.documentId, input.documentIds));
    }
    const rows = await this.db
      .select({
        id: documentChunks.id,
        documentId: documentChunks.documentId,
        title: documents.title,
        content: documentChunks.content,
        metadata: documentChunks.metadata,
        score,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(and(...filters))
      .orderBy(distance, documentChunks.id)
      .limit(input.limit);
    return rows.map((row) => ({ ...row, score: Number(row.score) }));
  }
}
