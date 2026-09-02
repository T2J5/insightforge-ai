import { describe, expect, it } from "vitest";

import {
  REQUIRED_REPORT_SECTION_KEYS,
  type CitedReportDraft,
  type Evidence,
} from "@insightforge/domain";

import { validateCitedReport } from "./citations";

const RUN_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_RUN_ID = "10000000-0000-4000-8000-000000000002";
const EVIDENCE_ID = "20000000-0000-4000-8000-000000000001";
const UNKNOWN_EVIDENCE_ID = "20000000-0000-4000-8000-000000000099";

const createEvidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  id: EVIDENCE_ID,
  runId: RUN_ID,
  ownerId: "user-1",
  claim: "示例公司 2025 年收入增长 20%。",
  sourceType: "web",
  sourceCategory: "official",
  sourceUrl: "https://example.com/annual-report",
  sourceTitle: "2025 年年度报告",
  publisher: "示例公司",
  publishedAt: new Date("2026-03-01T00:00:00.000Z"),
  retrievedAt: new Date("2026-09-01T00:00:00.000Z"),
  quote: "2025 年收入同比增长 20%。",
  documentId: null,
  page: null,
  confidence: 0.95,
  contentHash: "a".repeat(64),
  ...overrides,
});

const createCompleteDraft = (): CitedReportDraft => ({
  title: "示例公司企业调研报告",
  executiveSummary: [
    {
      markdown: "示例公司 2025 年收入增长 20%。",
      claimType: "fact",
      citationIds: [EVIDENCE_ID],
    },
  ],
  sections: REQUIRED_REPORT_SECTION_KEYS.map((key) => ({
    key,
    heading: key,
    blocks: [
      {
        markdown: `${key} 的分析。`,
        claimType: "inference",
        citationIds: [],
      },
    ],
  })),
});

describe("validateCitedReport", () => {
  it("允许章节完整且所有事实都引用当前任务证据的报告发布", () => {
    const result = validateCitedReport({
      draft: createCompleteDraft(),
      evidence: [createEvidence()],
      expectedRunId: RUN_ID,
      expectedOwnerId: "user-1",
    });

    expect(result).toMatchObject({
      publishable: true,
      factBlockCount: 1,
      citedFactBlockCount: 1,
      citationCoverage: 1,
      unknownEvidenceIds: [],
      uncitedFactLocations: [],
      missingSectionKeys: [],
    });
  });

  it("拒绝引用数据库中不存在的 Evidence ID", () => {
    const draft = createCompleteDraft();
    draft.executiveSummary[0]!.citationIds = [UNKNOWN_EVIDENCE_ID];

    const result = validateCitedReport({
      draft,
      evidence: [createEvidence()],
      expectedRunId: RUN_ID,
      expectedOwnerId: "user-1",
    });

    expect(result.publishable).toBe(false);
    expect(result.unknownEvidenceIds).toEqual([UNKNOWN_EVIDENCE_ID]);
    expect(result.uncitedFactLocations).toEqual(["executiveSummary.blocks[0]"]);
  });

  it("拒绝引用其他 Run 或其他用户的证据", () => {
    const otherOwnerEvidenceId = "20000000-0000-4000-8000-000000000002";
    const draft = createCompleteDraft();
    draft.executiveSummary[0]!.citationIds = [
      EVIDENCE_ID,
      otherOwnerEvidenceId,
    ];

    const result = validateCitedReport({
      draft,
      evidence: [
        createEvidence({ runId: OTHER_RUN_ID }),
        createEvidence({ id: otherOwnerEvidenceId, ownerId: "user-2" }),
      ],
      expectedRunId: RUN_ID,
      expectedOwnerId: "user-1",
    });

    expect(result.publishable).toBe(false);
    expect(result.crossRunEvidenceIds).toEqual([EVIDENCE_ID]);
    expect(result.crossOwnerEvidenceIds).toEqual([otherOwnerEvidenceId]);
    expect(result.citationCoverage).toBe(0);
  });

  it("拒绝没有有效引用的事实块", () => {
    const draft = createCompleteDraft();
    draft.executiveSummary[0]!.citationIds = [];

    const result = validateCitedReport({
      draft,
      evidence: [createEvidence()],
      expectedRunId: RUN_ID,
      expectedOwnerId: "user-1",
    });

    expect(result.publishable).toBe(false);
    expect(result.factBlockCount).toBe(1);
    expect(result.citedFactBlockCount).toBe(0);
    expect(result.citationCoverage).toBe(0);
    expect(result.uncitedFactLocations).toEqual(["executiveSummary.blocks[0]"]);
  });

  it("拒绝章节缺失、重复引用和无效网页地址", () => {
    const draft = createCompleteDraft();
    draft.sections = draft.sections.slice(1);
    draft.executiveSummary[0]!.citationIds = [EVIDENCE_ID, EVIDENCE_ID];

    const result = validateCitedReport({
      draft,
      evidence: [createEvidence({ sourceUrl: "not-a-url" })],
      expectedRunId: RUN_ID,
      expectedOwnerId: "user-1",
    });

    expect(result.publishable).toBe(false);
    expect(result.missingSectionKeys).toEqual(["company_overview"]);
    expect(result.duplicateCitationLocations).toEqual([
      "executiveSummary.blocks[0]",
    ]);
    expect(result.invalidSourceUrlEvidenceIds).toEqual([EVIDENCE_ID]);
  });
});
