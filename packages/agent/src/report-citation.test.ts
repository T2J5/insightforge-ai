import { describe, expect, it } from "vitest";

import type { EvidenceCandidate } from "./evidence-candidate";
import { validateReportCitations } from "./report-citation";
import type { ReportDraft } from "./state";

const evidenceCandidates: EvidenceCandidate[] = [
  {
    evidenceId: "E1",
    questionId: "q1",
    claim: "ByteDance 建设了推荐系统和数据基础设施。",
    sourceUrl: "https://example.com/technology",
    sourceTitle: "ByteDance Technology Overview",
    quote: "Recommendation systems and data infrastructure overview.",
    confidence: 0.9,
  },
  {
    evidenceId: "E2",
    questionId: "q1",
    claim: "ByteDance 运营大规模数据平台。",
    sourceUrl: "https://example.com/data-platform",
    sourceTitle: "ByteDance Data Platform",
    quote: "The company operates a large-scale data platform.",
    confidence: 0.8,
  },
];

const validReport: ReportDraft = {
  title: "ByteDance 技术调研",
  executiveSummary: "ByteDance 建设了推荐系统和数据基础设施。",
  executiveSummaryEvidenceIds: ["E1"],
  sections: [
    {
      heading: "核心技术",
      markdown: "ByteDance 运营大规模数据平台。",
      evidenceIds: ["E2"],
    },
  ],
};

describe("validateReportCitations", () => {
  it("accepts a report whose evidence IDs all exist", () => {
    expect(validateReportCitations(validReport, evidenceCandidates)).toEqual({
      valid: true,
      issues: [],
    });
  });

  it.each([
    {
      name: "executive summary",
      report: { ...validReport, executiveSummaryEvidenceIds: [] },
      location: "executiveSummary",
    },
    {
      name: "section",
      report: {
        ...validReport,
        sections: [{ ...validReport.sections[0]!, evidenceIds: [] }],
      },
      location: "sections[0]",
    },
  ])("rejects a missing evidence ID in the $name", ({ report, location }) => {
    const result = validateReportCitations(report, evidenceCandidates);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "MISSING_EVIDENCE_ID",
        location,
        evidenceId: null,
      }),
    ]);
  });

  it("reports unknown and duplicate evidence IDs", () => {
    const report: ReportDraft = {
      ...validReport,
      executiveSummaryEvidenceIds: ["E1", "E1", "E99"],
    };

    const result = validateReportCitations(report, evidenceCandidates);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "DUPLICATE_EVIDENCE_ID",
        location: "executiveSummary",
        evidenceId: "E1",
      }),
      expect.objectContaining({
        code: "UNKNOWN_EVIDENCE_ID",
        location: "executiveSummary",
        evidenceId: "E99",
      }),
    ]);
  });
});
