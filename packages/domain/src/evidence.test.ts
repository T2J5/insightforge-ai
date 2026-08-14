import { describe, expect, it } from "vitest";

import { EvidenceSchema } from "./evidence";

const evidenceId = "550e8400-e29b-41d4-a716-446655440000";
const runId = "550e8400-e29b-41d4-a716-446655440001";
const documentId = "550e8400-e29b-41d4-a716-446655440002";
const contentHash = "a".repeat(64);

const baseEvidence = {
  id: evidenceId,
  runId,
  ownerId: "user-1",
  claim: "字节跳动持续投入人工智能研发。",
  sourceTitle: "公司技术报告",
  publisher: "示例发布方",
  publishedAt: new Date("2026-08-01T00:00:00.000Z"),
  retrievedAt: new Date("2026-08-13T08:00:00.000Z"),
  quote: "公司持续投入人工智能研发。",
  page: null,
  confidence: 0.9,
  contentHash,
};

describe("EvidenceSchema", () => {
  it("接受带URL且不关联文档的网页证据", () => {
    const result = EvidenceSchema.parse({
      ...baseEvidence,
      sourceType: "web",
      sourceUrl: "https://example.com/report",
      documentId: null,
    });

    expect(result.sourceType).toBe("web");
    expect(result.sourceUrl).toBe("https://example.com/report");
  });

  it("接受带documentId和正页码的文档证据", () => {
    const result = EvidenceSchema.parse({
      ...baseEvidence,
      sourceType: "document",
      sourceUrl: null,
      documentId,
      page: 15,
    });

    expect(result.documentId).toBe(documentId);
    expect(result.page).toBe(15);
  });

  it.each([
    [
      "网页证据缺少URL",
      { sourceType: "web", sourceUrl: null, documentId: null },
    ],
    [
      "网页证据错误关联文档",
      {
        sourceType: "web",
        sourceUrl: "https://example.com/report",
        documentId,
      },
    ],
    [
      "文档证据缺少documentId",
      { sourceType: "document", sourceUrl: null, documentId: null },
    ],
  ])("拒绝%s", (_label, overrides) => {
    expect(
      EvidenceSchema.safeParse({ ...baseEvidence, ...overrides }).success,
    ).toBe(false);
  });

  it("拒绝越界置信度、非正页码和非SHA-256哈希", () => {
    const result = EvidenceSchema.safeParse({
      ...baseEvidence,
      sourceType: "document",
      sourceUrl: null,
      documentId,
      page: 0,
      confidence: 1.1,
      contentHash: "short-hash",
    });

    expect(result.success).toBe(false);
  });
});
