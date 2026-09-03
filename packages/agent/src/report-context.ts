import type { Evidence } from "@insightforge/domain";

export interface BuildReportEvidenceContextInput {
  evidence: readonly Evidence[];
  runId: string;
  ownerId: string;
  maxEvidence?: number;
  maxCharacters?: number;
}

/** Writer 真正需要的证据白名单，主动排除 ownerId、contentHash 等内部字段。 */
export interface ReportEvidenceContextItem {
  id: string;
  claim: string;
  quote: string;
  sourceType: Evidence["sourceType"];
  sourceCategory: Evidence["sourceCategory"];
  sourceTitle: string | null;
  sourceUrl: string | null;
  publisher: string | null;
  publishedAt: string | null;
  page: number | null;
  confidence: number;
}

const SOURCE_PRIORITY: Record<Evidence["sourceCategory"], number> = {
  official: 4,
  trusted_news: 3,
  secondary: 2,
  unknown: 1,
};

const toContextItem = (evidence: Evidence): ReportEvidenceContextItem => ({
  id: evidence.id,
  claim: evidence.claim,
  quote: evidence.quote,
  sourceType: evidence.sourceType,
  sourceCategory: evidence.sourceCategory,
  sourceTitle: evidence.sourceTitle,
  sourceUrl: evidence.sourceUrl,
  publisher: evidence.publisher,
  publishedAt: evidence.publishedAt?.toISOString() ?? null,
  page: evidence.page,
  confidence: evidence.confidence,
});

/**
 * 构建有界、稳定、最小披露的 Writer 证据上下文。
 *
 * 排序先比较来源等级，再比较置信度，最后用 ID 保证相同输入得到相同顺序。
 * 字符预算使用 JSON 长度近似；模型 Adapter 仍负责真正的 Token 上限。
 */
export const buildReportEvidenceContext = ({
  evidence,
  runId,
  ownerId,
  maxEvidence = 20, // 限制最大证据条数
  maxCharacters = 30_000, // 限制最大字符数
}: BuildReportEvidenceContextInput): ReportEvidenceContextItem[] => {
  if (!Number.isInteger(maxEvidence) || maxEvidence < 1) {
    throw new Error("REPORT_CONTEXT_MAX_EVIDENCE_INVALID");
  }
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error("REPORT_CONTEXT_MAX_CHARACTERS_INVALID");
  }

  const eligible = evidence
    .filter((item) => item.runId === runId && item.ownerId === ownerId)
    .sort(
      (left, right) =>
        SOURCE_PRIORITY[right.sourceCategory] -
          SOURCE_PRIORITY[left.sourceCategory] ||
        right.confidence - left.confidence ||
        left.id.localeCompare(right.id),
    );

  const selected: ReportEvidenceContextItem[] = [];
  let usedCharacters = 2; // JSON 数组的 []。

  for (const evidenceItem of eligible) {
    if (selected.length >= maxEvidence) break;
    const contextItem = toContextItem(evidenceItem);
    const itemCharacters = JSON.stringify(contextItem).length;
    const separatorCharacters = selected.length === 0 ? 0 : 1;

    if (usedCharacters + itemCharacters + separatorCharacters > maxCharacters) {
      continue;
    }

    selected.push(contextItem);
    usedCharacters += itemCharacters + separatorCharacters;
  }

  return selected;
};
