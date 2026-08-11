import { EvidenceSchema, type Evidence } from "@insightforge/domain";
import { asc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { evidence } from "../schema";

function toEvidence(row: typeof evidence.$inferSelect): Evidence {
  return EvidenceSchema.parse({
    ...row,
    confidence: Number(row.confidence),
  });
}

export class EvidenceRepository {
  constructor(private readonly database: Database) {}

  async upsert(input: Evidence): Promise<Evidence> {
    const value = EvidenceSchema.parse(input);
    const [saved] = await this.database
      .insert(evidence)
      .values({
        ...value,
        confidence: value.confidence.toString(),
      })
      .onConflictDoUpdate({
        target: [evidence.runId, evidence.contentHash],
        set: {
          ownerId: value.ownerId,
          claim: value.claim,
          sourceType: value.sourceType,
          sourceUrl: value.sourceUrl,
          sourceTitle: value.sourceTitle,
          publisher: value.publisher,
          publishedAt: value.publishedAt,
          retrievedAt: value.retrievedAt,
          quote: value.quote,
          documentId: value.documentId,
          page: value.page,
          confidence: value.confidence.toString(),
        },
      })
      .returning();

    if (!saved) {
      throw new Error("EVIDENCE_UPSERT_FAILED");
    }
    return toEvidence(saved);
  }

  async listForRun(runId: string): Promise<Evidence[]> {
    const rows = await this.database
      .select()
      .from(evidence)
      .where(eq(evidence.runId, runId))
      .orderBy(asc(evidence.retrievedAt), asc(evidence.id));
    return rows.map(toEvidence);
  }
}
