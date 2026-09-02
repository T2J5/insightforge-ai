import {
  CreateReportVersionSchema,
  ReportVersionSchema,
  type CreateReportVersion,
  type ReportVersion,
} from "@insightforge/domain";
import { reports, reportVersions } from "../schema";
import type { Database } from "../client";

import { eq, and, desc, or } from "drizzle-orm";

const hasSameImmutableContent = (
  existing: ReportVersion,
  requested: CreateReportVersion,
): boolean =>
  existing.reportId === requested.reportId &&
  existing.runId === requested.runId &&
  existing.ownerId === requested.ownerId &&
  existing.status === requested.status &&
  existing.qualityWarning === requested.qualityWarning &&
  JSON.stringify(existing.content) === JSON.stringify(requested.content);

/**
 * 将 report_versions 数据库记录转换为
 * Domain ReportVersion。
 */
const toReportVersion = (
  row: typeof reportVersions.$inferSelect,
): ReportVersion => {
  return ReportVersionSchema.parse({
    id: row.id,
    reportId: row.reportId,
    runId: row.runId,
    ownerId: row.ownerId,
    version: row.version,
    content: row.content,
    status: row.status,
    qualityWarning: row.qualityWarning,
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
  });
};
export class ReportRepository {
  constructor(private readonly db: Database) {}

  /**
   * 创建不可变的报告版本。
   *
   * 同一 reportId 的版本创建通过 reports 行锁串行化，
   * 避免并发请求分配到相同版本号。
   */
  async createVersion(input: CreateReportVersion): Promise<ReportVersion> {
    const parsed = CreateReportVersionSchema.parse(input);
    return this.db.transaction(async (transaction) => {
      /**
       * 第一次创建版本时，同时创建 reports 主记录。
       *
       * 幂等的主记录创建
       * 如果报告已经存在，则不重复插入。
       * reports 同时具有：
       *
       * PRIMARY KEY (id)
       * UNIQUE (run_id)
       */
      await transaction
        .insert(reports)
        .values({
          id: parsed.reportId,
          ownerId: parsed.ownerId,
          runId: parsed.runId,
        })
        .onConflictDoNothing();

      /**
       * 锁住报告主记录。
       *
       * 同一个 reportId 的其他事务会等待当前事务结束，
       * 不同 reportId 之间不会相互阻塞。
       * 核心并发控制
       * reportId 或 runId 任意一个已经存在时，
       * 都读取并锁住相关报告。
       */
      const lockedReports = await transaction
        .select()
        .from(reports)
        .where(
          or(eq(reports.id, parsed.reportId), eq(reports.runId, parsed.runId)),
        )
        // FOR UPDATE 锁住当前行，避免并发创建版本时分配到相同版本号。
        .for("update");

      /**
       * 正常情况下只应该找到一条报告记录。
       *
       * 找不到：
       * 主记录创建或冲突处理没有产生可用记录。
       *
       * 找到两条：
       * 输入的 reportId 和 runId 分别属于不同报告，
       * 属于交叉身份冲突。
       */
      if (lockedReports.length !== 1) {
        throw new Error("REPORT_IDENTITY_CONFLICT");
      }
      const report = lockedReports[0];
      if (
        !report ||
        report.id !== parsed.reportId ||
        report.runId !== parsed.runId ||
        report.ownerId !== parsed.ownerId
      ) {
        throw new Error("REPORT_IDENTITY_CONFLICT");
      }

      /**
       * reportId 一旦创建，其 runId 和 ownerId
       * 就不能被后续版本改变。
       */
      if (report.runId !== parsed.runId || report.ownerId !== parsed.ownerId) {
        throw new Error("REPORT_IDENTITY_CONFLICT");
      }

      /**
       * Agent 节点可能在“版本已写入、LangGraph Checkpoint 尚未提交”时退出。
       * 恢复后会使用相同的确定性版本 ID 重放写入。
       *
       * 相同 ID + 相同不可变内容：视为幂等成功。
       * 相同 ID + 不同内容：说明调用方试图覆盖历史版本，必须拒绝。
       */
      if (parsed.id) {
        const [existingRow] = await transaction
          .select()
          .from(reportVersions)
          .where(eq(reportVersions.id, parsed.id))
          .limit(1);

        if (existingRow) {
          const existing = toReportVersion(existingRow);
          if (!hasSameImmutableContent(existing, parsed)) {
            throw new Error("REPORT_VERSION_IDEMPOTENCY_CONFLICT");
          }
          return existing;
        }
      }

      /**
       * 由于 reports 行已经被 FOR UPDATE 锁定，
       * 当前事务可以安全读取最新版本号。
       *
       * 所有 createVersion() 调用都必须遵守：
       * 先锁 reports，再读取 report_versions。
       */
      const [latestVersion] = await transaction
        .select({
          version: reportVersions.version,
        })
        .from(reportVersions)
        .where(eq(reportVersions.reportId, parsed.reportId))
        .orderBy(desc(reportVersions.version))
        .limit(1);

      const nextVersion = (latestVersion?.version ?? 0) + 1;

      const publishedAt = parsed.status === "published" ? new Date() : null;

      /**
       * id 是可选字段。
       *
       * 未提供时不把 id 放入 values，
       * 让数据库使用 gen_random_uuid()。
       */
      const [createdVersion] = await transaction
        .insert(reportVersions)
        .values({
          ...(parsed.id ? { id: parsed.id } : {}),
          reportId: parsed.reportId,
          runId: parsed.runId,
          ownerId: parsed.ownerId,
          version: nextVersion,
          content: parsed.content,
          status: parsed.status,
          qualityWarning: parsed.qualityWarning,
          publishedAt,
        })
        .returning();

      if (!createdVersion) {
        throw new Error("REPORT_VERSION_CREATE_FAILED");
      }

      /**
       * reports.updatedAt 表示该报告最后一次
       * 创建版本的时间。
       */
      await transaction
        .update(reports)
        .set({
          updatedAt: new Date(),
        })
        .where(eq(reports.id, parsed.reportId));
      return toReportVersion(createdVersion);
    });
  }

  /**
   * 返回最新已发布版本。
   *
   * 草稿永远不会通过这个方法返回。
   */
  async getPublished(reportId: string): Promise<ReportVersion | null> {
    const [row] = await this.db
      .select()
      .from(reportVersions)
      .where(
        and(
          eq(reportVersions.reportId, reportId),
          eq(reportVersions.status, "published"),
        ),
      )
      .orderBy(desc(reportVersions.version))
      .limit(1);

    return row ? toReportVersion(row) : null;
  }
}
