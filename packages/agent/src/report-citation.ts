import z from "zod";
import {
  EvidenceIdSchema,
  type EvidenceCandidate,
  type EvidenceId,
} from "./evidence-candidate";
import type { ReportDraft } from "./state";

/**
 * 报告一个位置声明的证据 ID。
 *
 * 这里故意允许空数组和重复 ID。
 *
 * 原因：
 * 这些问题需要交给 citationValidator，
 * 让 Graph 有机会把报告送回 writer 修订。
 *
 * 如果直接在 Zod 中使用 min(1) 或唯一性 refine，
 * 模型输出会在 StructuredModel 层直接失败，
 * 无法进入 Graph 的修订路径。
 */
export const ReportEvidenceIdsSchema = z.array(EvidenceIdSchema).max(12);
export type ReportEvidenceIds = z.infer<typeof ReportEvidenceIdsSchema>;

export const ReportCitationIssueCodeSchema = z.enum([
  "MISSING_EVIDENCE_ID",
  "UNKNOWN_EVIDENCE_ID",
  "DUPLICATE_EVIDENCE_ID",
]);
export type ReportCitationIssueCode = z.infer<
  typeof ReportCitationIssueCodeSchema
>;

/**
 * 引用问题。
 *
 * location 示例：
 *
 * executiveSummary
 * sections[0]
 * sections[1]
 */
export const ReportCitationIssueSchema = z
  .object({
    code: ReportCitationIssueCodeSchema,
    location: z.string().trim().min(1).max(100),
    /**
     * 缺少引用时没有具体 ID，
     * 因此允许为 null。
     */
    evidenceId: EvidenceIdSchema.nullable(),
    message: z.string().trim().min(1).max(500),
  })
  .strict();
export type ReportCitationIssue = z.infer<typeof ReportCitationIssueSchema>;

export const ReportCitationValidationResultSchema = z
  .object({
    valid: z.boolean(),
    issues: z.array(ReportCitationIssueSchema).max(50),
  })
  .strict();
export type ReportCitationValidationResult = z.infer<
  typeof ReportCitationValidationResultSchema
>;

/**
 * 确定性检查报告引用。
 *
 * 该函数：
 *
 * - 不调用模型；
 * - 不产生 Token；
 * - 相同输入永远得到相同结果。
 */
export const validateReportCitations = (
  report: ReportDraft,
  evidenceCandidates: EvidenceCandidate[],
): ReportCitationValidationResult => {
  const knownEvidenceIds = new Set<EvidenceId>(
    evidenceCandidates.map((c) => c.evidenceId),
  );

  const issues: ReportCitationIssue[] = [];

  const validateLocation = (location: string, evidenceIds: EvidenceId[]) => {
    /**
     * 每个事实区域至少需要一条证据。
     */
    if (evidenceIds.length === 0) {
      issues.push({
        code: "MISSING_EVIDENCE_ID",
        location,
        evidenceId: null,
        message: `${location} 至少需要引用一条已验证证据`,
      });
      return;
    }

    const seenIds = new Set<EvidenceId>();

    for (const evidenceId of evidenceIds) {
      if (seenIds.has(evidenceId)) {
        issues.push({
          code: "DUPLICATE_EVIDENCE_ID",
          location,
          evidenceId,
          message: `${location} 引用了重复的证据 ID ${evidenceId}`,
        });
        continue;
      }
      seenIds.add(evidenceId);

      if (!knownEvidenceIds.has(evidenceId)) {
        issues.push({
          code: "UNKNOWN_EVIDENCE_ID",
          location,
          evidenceId,
          message: `${location} 引用了未知的证据 ID ${evidenceId}`,
        });
      }
    }
  };

  validateLocation("executiveSummary", report.executiveSummaryEvidenceIds);

  report.sections.forEach((section, index) => {
    const location = `sections[${index}]`;
    validateLocation(location, section.evidenceIds);
  });

  return ReportCitationValidationResultSchema.parse({
    valid: issues.length === 0,
    issues,
  });
};
