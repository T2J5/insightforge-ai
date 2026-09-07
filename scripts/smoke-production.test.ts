import { describe, expect, it, vi } from "vitest";

import { runProductionSmoke } from "./smoke-production";

const REPORT_ID = "10000000-0000-4000-8000-000000000001";
const EVIDENCE_ID = "20000000-0000-4000-8000-000000000001";
const report = {
  reportId: REPORT_ID,
  version: 1,
  content: {
    title: "演示报告",
    executiveSummary: [
      { markdown: "公开事实", claimType: "fact", citationIds: [EVIDENCE_ID] },
    ],
    sections: [
      {
        key: "company_overview",
        heading: "公司概览",
        blocks: [
          {
            markdown: "公开事实",
            claimType: "fact",
            citationIds: [EVIDENCE_ID],
          },
        ],
      },
    ],
  },
  citations: [
    {
      id: EVIDENCE_ID,
      sourceType: "web",
      sourceCategory: "official",
      sourceUrl: "https://example.com/source",
      sourceTitle: "Official source",
      publisher: "Example",
      publishedAt: null,
      quote: "公开事实",
    },
  ],
  qualityWarning: null,
  publishedAt: "2026-09-07T00:00:00.000Z",
};

describe("runProductionSmoke", () => {
  it("验证健康、预置报告、完成事件与冒烟报告", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        return Response.json({
          status: "ok",
          service: "insightforge-web",
          version: "test-sha",
          dependencies: { database: { status: "up" }, redis: { status: "up" } },
        });
      }
      if (url.endsWith("/api/smoke/runs")) {
        return Response.json({
          runId: REPORT_ID,
          reportId: REPORT_ID,
          status: "completed",
          events: [
            {
              type: "status",
              status: "completed",
              stage: "completed",
              progress: 100,
            },
          ],
        });
      }
      return Response.json(report);
    });
    const result = await runProductionSmoke({
      baseUrl: "https://insightforge.example",
      smokeToken: "a".repeat(32),
      reportIds: [REPORT_ID],
      fetchImpl,
    });
    expect(result).toMatchObject({ status: "passed", demoReportsChecked: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("拒绝不安全的引用 URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/api/health")) {
        return Response.json({
          status: "ok",
          service: "insightforge-web",
          version: "test",
          dependencies: { database: { status: "up" }, redis: { status: "up" } },
        });
      }
      return Response.json({
        ...report,
        citations: [{ ...report.citations[0], sourceUrl: "ftp://example.com" }],
      });
    });
    await expect(
      runProductionSmoke({
        baseUrl: "https://insightforge.example",
        smokeToken: "a".repeat(32),
        reportIds: [REPORT_ID],
        fetchImpl,
      }),
    ).rejects.toThrow();
  });
});
