import { EvidenceSchema, type Evidence } from "@insightforge/domain";
import type { Database } from "../client";
import { evidence as evidenceTable } from "../schema";

import { asc, eq } from "drizzle-orm";
/**
 * 将 evidence 数据库记录转换为领域 Evidence。
 *
 * PostgreSQL numeric 默认返回字符串，
 * 但 Domain 中 confidence 是 number，
 * 因此需要显式转换。
 *
 * 这里明确选择 Domain 需要的字段，
 * 避免把数据库专用的 createdAt 暴露给上层。
 */
const toEvidence = (row: typeof evidenceTable.$inferSelect): Evidence => {
  return EvidenceSchema.parse({
    id: row.id,
    runId: row.runId,
    ownerId: row.ownerId,
    claim: row.claim,
    sourceType: row.sourceType,
    sourceUrl: row.sourceUrl,
    sourceTitle: row.sourceTitle,
    publisher: row.publisher,
    publishedAt: row.publishedAt,
    confidence: Number(row.confidence),
    retrievedAt: row.retrievedAt,
    quote: row.quote,
    documentId: row.documentId,
    page: row.page,
    contentHash: row.contentHash,
  });
};

export class EvidenceRepository {
  constructor(private readonly db: Database) {}

  /**
   * 幂等保存证据。
   *
   * 第一次保存时插入记录。
   * 相同 runId + contentHash 再次保存时，
   * 更新原有证据内容并保留原ID。
   */
  async upsert(input: Evidence): Promise<Evidence> {
    const parsed = EvidenceSchema.parse(input);
    const [row] = await this.db
      .insert(evidenceTable)
      .values({
        id: parsed.id,
        runId: parsed.runId,
        ownerId: parsed.ownerId,
        claim: parsed.claim,
        sourceType: parsed.sourceType,
        sourceUrl: parsed.sourceUrl,
        sourceTitle: parsed.sourceTitle,
        publisher: parsed.publisher,
        publishedAt: parsed.publishedAt,
        retrievedAt: parsed.retrievedAt,
        quote: parsed.quote,
        documentId: parsed.documentId,
        page: parsed.page,
        /**
         * 数据库列是 numeric(4, 3)，
         * Drizzle 的 Insert 类型要求 string。
         */
        confidence: parsed.confidence.toString(),
        contentHash: parsed.contentHash,
      })
      .onConflictDoUpdate({
        /**
         * 必须与数据库唯一索引保持一致：
         *
         * UNIQUE (run_id, content_hash)
         */
        target: [evidenceTable.runId, evidenceTable.contentHash],
        /**
         * 发生冲突时更新证据内容，
         * 但不更新身份字段：
         *
         * id
         * runId
         * ownerId
         * contentHash
         * createdAt
         */
        set: {
          claim: parsed.claim,
          sourceType: parsed.sourceType,
          sourceUrl: parsed.sourceUrl,
          sourceTitle: parsed.sourceTitle,
          publisher: parsed.publisher,
          publishedAt: parsed.publishedAt,
          retrievedAt: parsed.retrievedAt,
          quote: parsed.quote,
          documentId: parsed.documentId,
          page: parsed.page,
          confidence: parsed.confidence.toString(),
        },
      })
      .returning();

    if (!row) {
      throw new Error("EVIDENCE_UPSERT_FAILED");
    }

    return toEvidence(row);
  }

  /**
   * 查询指定调研任务的全部证据。
   *
   * retrievedAt 作为第一排序字段，
   * id 作为时间相同时的稳定排序字段。
   */
  async listForRun(runId: string): Promise<Evidence[]> {
    const rows = await this.db
      .select()
      .from(evidenceTable)
      .where(eq(evidenceTable.runId, runId))
      .orderBy(asc(evidenceTable.retrievedAt), asc(evidenceTable.id));

    return rows.map(toEvidence);
  }
}
