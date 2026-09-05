import { researchRuns, usageEvents, type Database } from "@insightforge/db";
import type { UsageEvent, UsageSink } from "@insightforge/observability";
import { eq } from "drizzle-orm";

/**
 * 将脱敏后的模型用量写入 PostgreSQL，供管理员接口聚合查询。
 *
 * UsageEvent 只携带 runId，不接受调用方自行声明 ownerId。这里先从权威的
 * research_runs 表读取所有者，避免一条伪造事件把用量记到其他账号名下。
 */
export class DatabaseUsageSink implements UsageSink {
  constructor(private readonly database: Database) {}

  async record(event: UsageEvent): Promise<void> {
    const [run] = await this.database
      .select({ ownerId: researchRuns.ownerId })
      .from(researchRuns)
      .where(eq(researchRuns.id, event.runId))
      .limit(1);
    if (!run) throw new Error("USAGE_RUN_NOT_FOUND");

    /**
     * metadata 采用白名单构造，而不是把 event 整体序列化：
     * - 防止 prompt、响应正文或密钥被意外持久化；
     * - 保持管理员查询依赖的字段结构稳定。
     *
     * insert 被 await，写入失败会向上抛出。当前策略强调审计数据完整性；
     * 若未来改为 best-effort，必须另设错误日志/指标，不能静默吞掉失败。
     */
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
