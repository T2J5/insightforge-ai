import {
  REQUIRED_REPORT_SECTION_KEYS,
  type CitedReportDraft,
  type Evidence,
  type ReportVersion,
} from "@insightforge/domain";
import { describe, expect, it, vi } from "vitest";

import {
  PublicReportService,
  PublishedReportNotFoundError,
  ReportNotPublicError,
} from "./report-service";

const REPORT_ID = "550e8400-e29b-41d4-a716-446655440000";
const EVIDENCE_ID = "650e8400-e29b-41d4-a716-446655440000";

const content: CitedReportDraft = {
  title: "公开企业调研",
  executiveSummary: [
    { markdown: "公开事实", claimType: "fact", citationIds: [EVIDENCE_ID] },
  ],
  sections: REQUIRED_REPORT_SECTION_KEYS.map((key) => ({
    key,
    heading: key,
    blocks: [{ markdown: key, claimType: "summary", citationIds: [] }],
  })),
};

const report: ReportVersion = {
  id: "750e8400-e29b-41d4-a716-446655440000",
  reportId: REPORT_ID,
  runId: REPORT_ID,
  ownerId: "private-owner-id",
  version: 2,
  content,
  status: "published",
  qualityWarning: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  publishedAt: new Date("2026-09-01T00:01:00.000Z"),
};

const evidence: Evidence = {
  id: EVIDENCE_ID,
  runId: REPORT_ID,
  ownerId: "private-owner-id",
  claim: "内部标准化结论",
  sourceType: "web",
  sourceCategory: "official",
  sourceUrl: "https://example.com/report",
  sourceTitle: "Annual Report",
  publisher: "Example",
  publishedAt: null,
  retrievedAt: new Date("2026-09-01T00:00:00.000Z"),
  quote: "Public source quote",
  documentId: null,
  page: null,
  confidence: 0.9,
  contentHash: "a".repeat(64),
};

const createService = (
  reportResult: ReportVersion | null = report,
  evidenceResult: Evidence[] = [evidence],
) =>
  new PublicReportService(
    { getPublished: vi.fn().mockResolvedValue(reportResult) },
    { listForRun: vi.fn().mockResolvedValue(evidenceResult) },
  );

describe("PublicReportService", () => {
  it("只返回已发布正文和公开引用白名单", async () => {
    const result = await createService().getPublished(REPORT_ID);
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      reportId: REPORT_ID,
      version: 2,
      content,
      citations: [
        {
          id: EVIDENCE_ID,
          sourceType: "web",
          sourceCategory: "official",
          sourceUrl: "https://example.com/report",
          sourceTitle: "Annual Report",
          publisher: "Example",
          publishedAt: null,
          quote: "Public source quote",
        },
      ],
      qualityWarning: null,
      publishedAt: "2026-09-01T00:01:00.000Z",
    });
    expect(serialized).not.toContain("private-owner-id");
    expect(serialized).not.toContain("contentHash");
    expect(serialized).not.toContain("documentId");
    expect(serialized).not.toContain("内部标准化结论");
  });

  it("草稿或不存在的报告统一视为未找到", async () => {
    await expect(
      createService(null).getPublished(REPORT_ID),
    ).rejects.toBeInstanceOf(PublishedReportNotFoundError);
  });

  it("拒绝通过匿名接口公开上传文档证据", async () => {
    const privateEvidence: Evidence = {
      ...evidence,
      sourceType: "document",
      sourceUrl: null,
      documentId: "850e8400-e29b-41d4-a716-446655440000",
      page: 3,
    };

    await expect(
      createService(report, [privateEvidence]).getPublished(REPORT_ID),
    ).rejects.toBeInstanceOf(ReportNotPublicError);
  });

  it("引用缺失或不属于报告身份时拒绝返回损坏报告", async () => {
    await expect(
      createService(report, []).getPublished(REPORT_ID),
    ).rejects.toThrow("PUBLISHED_REPORT_CITATION_INTEGRITY_ERROR");
  });
});
