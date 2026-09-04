import { researchRuns, usageEvents, type Database } from "@insightforge/db";
import type { UsageEvent, UsageSink } from "@insightforge/observability";
import { eq } from "drizzle-orm";

/** 将脱敏后的模型用量写入 PostgreSQL，供管理员接口聚合查询。 */
export class DatabaseUsageSink implements UsageSink {
  constructor(private readonly database: Database) {}

  async record(event: UsageEvent): Promise<void> {
    const [run] = await this.database
      .select({ ownerId: researchRuns.ownerId })
      .from(researchRuns)
      .where(eq(researchRuns.id, event.runId))
      .limit(1);
    if (!run) throw new Error("USAGE_RUN_NOT_FOUND");
    await this.database.insert(usageEvents).values({
      runId: event.runId,
      ownerId: run.ownerId,
      provider: "ai-sdk",
      model: event.model,
      operation: event.operation,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      estimatedCostCny: String(event.estimatedCostCny),
      metadata: {
        traceId: event.traceId,
        latencyMs: event.latencyMs,
        cacheHit: event.cacheHit,
        retryCount: event.retryCount,
      },
      createdAt: new Date(event.occurredAt),
    });
  }
}
