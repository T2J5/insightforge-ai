export interface CitationClaim {
  kind: "fact" | "inference" | "summary";
  citationIds: readonly string[];
}

/** 前 k 个结果覆盖了多少个相关证据。 */
export const recallAtK = (
  rankedKeys: readonly string[],
  relevantKeys: ReadonlySet<string>,
  k: number,
): number => {
  if (!Number.isInteger(k) || k < 1) throw new Error("METRIC_K_INVALID");
  if (relevantKeys.size === 0) return 1;
  const retrieved = new Set(rankedKeys.slice(0, k));
  let hits = 0;
  for (const key of relevantKeys) if (retrieved.has(key)) hits += 1;
  return hits / relevantKeys.size;
};

/** 第一条相关证据的倒数排名；没有命中时为 0。 */
export const reciprocalRank = (
  rankedKeys: readonly string[],
  relevantKeys: ReadonlySet<string>,
): number => {
  const index = rankedKeys.findIndex((key) => relevantKeys.has(key));
  return index < 0 ? 0 : 1 / (index + 1);
};

/** 多个查询 Reciprocal Rank 的算术平均。 */
export const mrr = (
  rankings: readonly (readonly string[])[],
  relevantByQuery: readonly ReadonlySet<string>[],
): number => {
  if (rankings.length !== relevantByQuery.length) {
    throw new Error("METRIC_QUERY_COUNT_MISMATCH");
  }
  if (rankings.length === 0) return 0;
  return (
    rankings.reduce(
      (sum, ranked, index) =>
        sum + reciprocalRank(ranked, relevantByQuery[index]!),
      0,
    ) / rankings.length
  );
};

/** 事实块中至少包含一个有效引用的比例；推断和摘要不进入分母。 */
export const citationCoverage = (
  claims: readonly CitationClaim[],
  validCitationIds?: ReadonlySet<string>,
): number => {
  const facts = claims.filter((claim) => claim.kind === "fact");
  if (facts.length === 0) return 1;
  const covered = facts.filter((claim) =>
    claim.citationIds.some(
      (id) => !validCitationIds || validCitationIds.has(id),
    ),
  ).length;
  return covered / facts.length;
};

export interface ToolAccuracyInput {
  usedTools: readonly string[];
  allowedTools: ReadonlySet<string>;
  forbiddenTools: ReadonlySet<string>;
}

/** 合法工具调用数 / 全部工具调用数；零调用且无违规时记为 1。 */
export const toolAccuracy = ({
  usedTools,
  allowedTools,
  forbiddenTools,
}: ToolAccuracyInput): number => {
  if (usedTools.length === 0) return 1;
  const valid = usedTools.filter(
    (tool) => allowedTools.has(tool) && !forbiddenTools.has(tool),
  ).length;
  return valid / usedTools.length;
};

export const runSuccessRate = (results: readonly boolean[]): number =>
  results.length === 0 ? 0 : results.filter(Boolean).length / results.length;

export const mean = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
