import {
  PublicPublishedReportSchema,
  type Evidence,
  type PublicPublishedReport,
  type ReportVersion,
} from "@insightforge/domain";

export interface PublishedReportStore {
  getPublished(reportId: string): Promise<ReportVersion | null>;
}

export interface PublishedReportEvidenceStore {
  listForRun(runId: string): Promise<Evidence[]>;
}

export class PublishedReportNotFoundError extends Error {
  readonly code = "REPORT_NOT_FOUND";
  constructor() {
    super("REPORT_NOT_FOUND");
    this.name = "PublishedReportNotFoundError";
  }
}

export class ReportNotPublicError extends Error {
  readonly code = "REPORT_NOT_PUBLIC";
  constructor() {
    super("REPORT_NOT_PUBLIC");
    this.name = "ReportNotPublicError";
  }
}

const collectCitationIds = (content: ReportVersion["content"]): Set<string> => {
  const ids = new Set<string>();
  content.executiveSummary.forEach((block) =>
    block.citationIds.forEach((id) => ids.add(id)),
  );
  content.sections.forEach((section) =>
    section.blocks.forEach((block) =>
      block.citationIds.forEach((id) => ids.add(id)),
    ),
  );
  return ids;
};

/** 返回最新已发布版本，并通过显式字段映射防止内部字段泄露。 */
export class PublicReportService {
  constructor(
    private readonly reports: PublishedReportStore,
    private readonly evidence: PublishedReportEvidenceStore,
  ) {}

  async getPublished(reportId: string): Promise<PublicPublishedReport> {
    const report = await this.reports.getPublished(reportId);
    if (!report) throw new PublishedReportNotFoundError();

    const requiredIds = collectCitationIds(report.content);
    const evidence = (await this.evidence.listForRun(report.runId)).filter(
      (item) =>
        requiredIds.has(item.id) &&
        item.runId === report.runId &&
        item.ownerId === report.ownerId,
    );
    if (evidence.length !== requiredIds.size) {
      throw new Error("PUBLISHED_REPORT_CITATION_INTEGRITY_ERROR");
    }

    /** 私有文档内容不能因为报告发布状态而自动变成匿名公开内容。 */
    if (evidence.some((item) => item.sourceType === "document")) {
      throw new ReportNotPublicError();
    }

    const citations = evidence.map((item) => ({
      id: item.id,
      sourceType: "web" as const,
      sourceCategory: item.sourceCategory,
      sourceUrl: item.sourceUrl,
      sourceTitle: item.sourceTitle,
      publisher: item.publisher,
      publishedAt: item.publishedAt?.toISOString() ?? null,
      quote: item.quote,
    }));
    if (!report.publishedAt) throw new Error("PUBLISHED_REPORT_DATE_REQUIRED");

    return PublicPublishedReportSchema.parse({
      reportId: report.reportId,
      version: report.version,
      content: report.content,
      citations,
      qualityWarning: report.qualityWarning,
      publishedAt: report.publishedAt.toISOString(),
    });
  }
}
