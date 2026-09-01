export interface RrfResult {
  id: string;
  score: number;
  bestRank: number;
}

/** Reciprocal Rank Fusion：只使用排名，不要求两路原始分数处于同一量纲。 */
export const rrf = (
  rankings: readonly (readonly string[])[],
  rankConstant = 60,
): RrfResult[] => {
  if (!Number.isInteger(rankConstant) || rankConstant < 1) {
    throw new Error("RRF_CONSTANT_INVALID");
  }
  /** score = Σ 1 / (k + rank)，因此在多路都靠前的候选会获得更高总分。 */
  const results = new Map<string, RrfResult>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      const rank = index + 1;
      const current = results.get(id) ?? { id, score: 0, bestRank: rank };
      current.score += 1 / (rankConstant + rank);
      current.bestRank = Math.min(current.bestRank, rank);
      results.set(id, current);
    });
  }
  return [...results.values()].sort(
    (left, right) =>
      right.score - left.score ||
      left.bestRank - right.bestRank ||
      left.id.localeCompare(right.id),
  );
};
