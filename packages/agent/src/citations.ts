import {
  REQUIRED_REPORT_SECTION_KEYS,
  type CitedReportDraft,
  type Evidence,
  type RequiredReportSectionKey,
} from "@insightforge/domain";

export const MIN_FACT_CITATION_COVERAGE = 0.95;

export interface CitedReportValidationInput {
  draft: CitedReportDraft;
  evidence: readonly Evidence[];
  expectedRunId: string;
  expectedOwnerId: string;
}

export interface CitedReportValidationResult {
  publishable: boolean;
  factBlockCount: number;
  citedFactBlockCount: number;
  citationCoverage: number;
  unknownEvidenceIds: string[];
  crossRunEvidenceIds: string[];
  crossOwnerEvidenceIds: string[];
  invalidSourceUrlEvidenceIds: string[];
  duplicateCitationLocations: string[];
  duplicateSectionKeys: string[];
  uncitedFactLocations: string[];
  missingSectionKeys: RequiredReportSectionKey[];
}

const unique = (values: Iterable<string>): string[] => [...new Set(values)];

const isValidPublicHttpUrl = (value: string | null): boolean => {
  if (value === null) return false;

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/**
 * 在调用模型 Reviewer 之前执行的确定性检查。
 *
 * 模型适合判断“证据是否真的支持论断”，程序更适合判断 ID 是否存在、
 * 是否属于当前用户和任务、章节是否齐全等客观规则。两类检查不能互相替代。
 */
export const validateCitedReport = ({
  draft,
  evidence,
  expectedRunId,
  expectedOwnerId,
}: CitedReportValidationInput): CitedReportValidationResult => {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const unknownEvidenceIds = new Set<string>();
  const crossRunEvidenceIds = new Set<string>();
  const crossOwnerEvidenceIds = new Set<string>();
  const invalidSourceUrlEvidenceIds = new Set<string>();
  const duplicateCitationLocations: string[] = [];
  const uncitedFactLocations: string[] = [];

  let factBlockCount = 0;
  let citedFactBlockCount = 0;

  const validateBlock = (
    block: CitedReportDraft["executiveSummary"][number],
    location: string,
  ) => {
    if (new Set(block.citationIds).size !== block.citationIds.length) {
      duplicateCitationLocations.push(location);
    }

    let hasAllowedEvidence = false;

    for (const evidenceId of block.citationIds) {
      const item = evidenceById.get(evidenceId);

      if (!item) {
        unknownEvidenceIds.add(evidenceId);
        continue;
      }

      if (item.runId !== expectedRunId) {
        crossRunEvidenceIds.add(evidenceId);
        continue;
      }

      if (item.ownerId !== expectedOwnerId) {
        crossOwnerEvidenceIds.add(evidenceId);
        continue;
      }

      if (item.sourceType === "web" && !isValidPublicHttpUrl(item.sourceUrl)) {
        invalidSourceUrlEvidenceIds.add(evidenceId);
        continue;
      }

      hasAllowedEvidence = true;
    }

    if (block.claimType !== "fact") return;

    factBlockCount += 1;
    if (hasAllowedEvidence) {
      citedFactBlockCount += 1;
    } else {
      uncitedFactLocations.push(location);
    }
  };

  draft.executiveSummary.forEach((block, index) => {
    validateBlock(block, `executiveSummary.blocks[${index}]`);
  });

  draft.sections.forEach((section, sectionIndex) => {
    section.blocks.forEach((block, blockIndex) => {
      validateBlock(block, `sections[${sectionIndex}].blocks[${blockIndex}]`);
    });
  });

  const presentSectionKeys = new Set(
    draft.sections.map((section) => section.key),
  );
  const duplicateSectionKeys = draft.sections
    .map((section) => section.key)
    .filter((key, index, keys) => keys.indexOf(key) !== index)
    .filter((key, index, keys) => keys.indexOf(key) === index);
  const missingSectionKeys = REQUIRED_REPORT_SECTION_KEYS.filter(
    (key) => !presentSectionKeys.has(key),
  );
  const citationCoverage =
    factBlockCount === 0 ? 1 : citedFactBlockCount / factBlockCount;

  const hasIntegrityFailure =
    unknownEvidenceIds.size > 0 ||
    crossRunEvidenceIds.size > 0 ||
    crossOwnerEvidenceIds.size > 0 ||
    invalidSourceUrlEvidenceIds.size > 0 ||
    duplicateCitationLocations.length > 0 ||
    duplicateSectionKeys.length > 0 ||
    missingSectionKeys.length > 0;

  return {
    publishable:
      !hasIntegrityFailure && citationCoverage >= MIN_FACT_CITATION_COVERAGE,
    factBlockCount,
    citedFactBlockCount,
    citationCoverage,
    unknownEvidenceIds: unique(unknownEvidenceIds),
    crossRunEvidenceIds: unique(crossRunEvidenceIds),
    crossOwnerEvidenceIds: unique(crossOwnerEvidenceIds),
    invalidSourceUrlEvidenceIds: unique(invalidSourceUrlEvidenceIds),
    duplicateCitationLocations,
    duplicateSectionKeys,
    uncitedFactLocations,
    missingSectionKeys,
  };
};
