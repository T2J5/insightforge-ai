import {
  CreateReportVersionSchema,
  ReportVersionSchema,
  type CreateReportVersion,
  type ReportVersion,
} from "@insightforge/domain";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { reports, reportVersions } from "../schema";

type VersionRow = typeof reportVersions.$inferSelect;

function toReportVersion(
  row: VersionRow,
  report: { runId: string; ownerId: string },
): ReportVersion {
  return ReportVersionSchema.parse({
    ...row,
    runId: report.runId,
    ownerId: report.ownerId,
  });
}

export class ReportRepository {
  constructor(private readonly database: Database) {}

  async createVersion(input: CreateReportVersion): Promise<ReportVersion> {
    const value = CreateReportVersionSchema.parse(input);
    return this.database.transaction(async (transaction) => {
      await transaction
        .insert(reports)
        .values({
          id: value.reportId,
          runId: value.runId,
          ownerId: value.ownerId,
        })
        .onConflictDoNothing({ target: reports.id });

      const [report] = await transaction
        .select()
        .from(reports)
        .where(eq(reports.id, value.reportId))
        .for("update")
        .limit(1);
      if (
        !report ||
        report.runId !== value.runId ||
        report.ownerId !== value.ownerId
      ) {
        throw new Error("REPORT_IDENTITY_CONFLICT");
      }

      const [latest] = await transaction
        .select({ version: reportVersions.version })
        .from(reportVersions)
        .where(eq(reportVersions.reportId, value.reportId))
        .orderBy(desc(reportVersions.version))
        .limit(1);
      const version = (latest?.version ?? 0) + 1;
      const [created] = await transaction
        .insert(reportVersions)
        .values({
          ...(value.id ? { id: value.id } : {}),
          reportId: value.reportId,
          version,
          content: value.content,
          status: value.status,
          qualityWarning: value.qualityWarning,
          publishedAt: value.status === "published" ? new Date() : null,
        })
        .returning();

      if (!created) {
        throw new Error("REPORT_VERSION_CREATE_FAILED");
      }
      return toReportVersion(created, report);
    });
  }

  async getPublished(reportId: string): Promise<ReportVersion | null> {
    const [result] = await this.database
      .select({ version: reportVersions, report: reports })
      .from(reportVersions)
      .innerJoin(reports, eq(reportVersions.reportId, reports.id))
      .where(
        and(
          eq(reportVersions.reportId, reportId),
          eq(reportVersions.status, "published"),
        ),
      )
      .orderBy(desc(reportVersions.version))
      .limit(1);
    return result ? toReportVersion(result.version, result.report) : null;
  }
}
