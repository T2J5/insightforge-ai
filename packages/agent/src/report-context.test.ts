import type { Evidence } from "@insightforge/domain";
import { describe, expect, it } from "vitest";

import { buildReportEvidenceContext } from "./report-context";

const createEvidence = (
  id: string,
  overrides: Partial<Evidence> = {},
): Evidence => ({
  id,
  runId: "550e8400-e29b-41d4-a716-446655440000",
  ownerId: "owner-1",
  claim: "claim",
  sourceType: "web",
  sourceCategory: "secondary",
  sourceUrl: "https://example.com/source",
  sourceTitle: "Source",
  publisher: null,
  publishedAt: null,
  retrievedAt: new Date("2026-09-01T00:00:00.000Z"),
  quote: "quote",
  documentId: null,
  page: null,
  confidence: 0.8,
  contentHash: "a".repeat(64),
  ...overrides,
});

describe("buildReportEvidenceContext", () => {
  it("只选择当前 Run 和用户的 Evidence，并移除内部字段", () => {
    const result = buildReportEvidenceContext({
      evidence: [
        createEvidence("10000000-0000-4000-8000-000000000001"),
        createEvidence("10000000-0000-4000-8000-000000000002", {
          ownerId: "owner-2",
        }),
        createEvidence("10000000-0000-4000-8000-000000000003", {
          runId: "650e8400-e29b-41d4-a716-446655440000",
        }),
      ],
      runId: "550e8400-e29b-41d4-a716-446655440000",
      ownerId: "owner-1",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("ownerId");
    expect(result[0]).not.toHaveProperty("contentHash");
    expect(result[0]).not.toHaveProperty("documentId");
  });

  it("优先选择高质量来源并同时限制条数和字符数", () => {
    const official = createEvidence("10000000-0000-4000-8000-000000000001", {
      sourceCategory: "official",
      confidence: 0.7,
    });
    const secondary = createEvidence("10000000-0000-4000-8000-000000000002", {
      sourceCategory: "secondary",
      confidence: 0.99,
    });

    const limited = buildReportEvidenceContext({
      evidence: [secondary, official],
      runId: official.runId,
      ownerId: official.ownerId,
      maxEvidence: 1,
      maxCharacters: 5_000,
    });
    expect(limited.map((item) => item.id)).toEqual([official.id]);

    const tooSmall = buildReportEvidenceContext({
      evidence: [official],
      runId: official.runId,
      ownerId: official.ownerId,
      maxCharacters: 2,
    });
    expect(tooSmall).toEqual([]);
  });
});
