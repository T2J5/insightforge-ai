import { createHash, randomUUID } from "node:crypto";

import { EvidenceSchema, type Evidence } from "@insightforge/domain";

import {
  EvidenceCandidateSchema,
  type EvidenceCandidate,
} from "./evidence-candidate";
import { classifySourceQuality } from "./source-quality";
import { canonicalizeWebUrl } from "./tools/search-web";

export const normalizeEvidenceText = (value: string): string =>
  value.replace(/\s+/gu, " ").trim();

export interface NormalizeWebEvidenceInput {
  runId: string;
  ownerId: string;
  candidate: EvidenceCandidate;
  publisher?: string | null;
  publishedAt?: string | null;
  retrievedAt: Date;
  officialDomains?: readonly string[];
}

export interface NormalizeWebEvidenceDependencies {
  createId?: () => string;
}

export const normalizeWebEvidence = (
  input: NormalizeWebEvidenceInput,
  dependencies: NormalizeWebEvidenceDependencies = {},
): Evidence => {
  const candidate = EvidenceCandidateSchema.parse(input.candidate);
  const canonicalUrl = canonicalizeWebUrl(candidate.sourceUrl);
  const normalizedQuote = normalizeEvidenceText(candidate.quote);
  if (normalizedQuote.length === 0) {
    throw new Error("EVIDENCE_QUOTE_EMPTY");
  }

  const publishedAt =
    input.publishedAt === undefined || input.publishedAt === null
      ? null
      : new Date(input.publishedAt);
  if (publishedAt !== null && Number.isNaN(publishedAt.getTime())) {
    throw new Error("EVIDENCE_PUBLISHED_AT_INVALID");
  }

  const contentHash = createHash("sha256")
    .update(["web", canonicalUrl, normalizedQuote].join("\u0000"), "utf8")
    .digest("hex");
  const sourceQuality = classifySourceQuality({
    url: canonicalUrl,
    officialDomains: input.officialDomains,
  });

  return EvidenceSchema.parse({
    id: (dependencies.createId ?? randomUUID)(),
    runId: input.runId,
    ownerId: input.ownerId,
    claim: candidate.claim,
    sourceType: "web",
    sourceCategory: sourceQuality.category,
    sourceUrl: canonicalUrl,
    sourceTitle: candidate.sourceTitle,
    publisher: input.publisher ?? null,
    publishedAt,
    retrievedAt: input.retrievedAt,
    quote: candidate.quote,
    documentId: null,
    page: null,
    confidence: candidate.confidence,
    contentHash,
  });
};
