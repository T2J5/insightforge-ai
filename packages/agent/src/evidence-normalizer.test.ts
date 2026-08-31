import { describe, expect, it } from "vitest";

import { normalizeWebEvidence } from "./evidence-normalizer";
import type { EvidenceCandidate } from "./evidence-candidate";

const candidate: EvidenceCandidate = {
  evidenceId: "E1",
  questionId: "q1",
  claim: "The company operates a public research platform.",
  sourceUrl: "https://Example.com/report/?utm_source=test#section",
  sourceTitle: "Company report",
  quote: "The company operates a public research platform.",
  confidence: 0.9,
};

const baseInput = {
  runId: "550e8400-e29b-41d4-a716-446655440000",
  ownerId: "owner-1",
  candidate,
  retrievedAt: new Date("2026-08-31T00:00:00.000Z"),
};

describe("normalizeWebEvidence", () => {
  it("creates a valid web Evidence with a canonical URL", () => {
    const result = normalizeWebEvidence(baseInput, {
      createId: () => "c0a80121-7ac0-4b18-9f20-6d9ad634b573",
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: "c0a80121-7ac0-4b18-9f20-6d9ad634b573",
        sourceType: "web",
        sourceCategory: "unknown",
        sourceUrl: "https://example.com/report",
        publisher: null,
        publishedAt: null,
        documentId: null,
        page: null,
      }),
    );
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("uses canonical URL and normalized quote as the stable identity", () => {
    const first = normalizeWebEvidence(baseInput);
    const second = normalizeWebEvidence({
      ...baseInput,
      candidate: {
        ...candidate,
        claim: "A differently worded claim.",
        sourceUrl: "https://example.com/report",
        quote: "The company   operates a public\nresearch platform.",
      },
    });

    expect(second.contentHash).toBe(first.contentHash);
  });

  it("creates a different hash for a different quote", () => {
    const first = normalizeWebEvidence(baseInput);
    const second = normalizeWebEvidence({
      ...baseInput,
      candidate: {
        ...candidate,
        quote: "A different statement from the same page.",
      },
    });

    expect(second.contentHash).not.toBe(first.contentHash);
  });
});
