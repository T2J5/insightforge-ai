export interface RerankCandidate {
  id: string;
  content: string;
  fusionScore: number;
}

export interface RerankerPort {
  rerank(
    query: string,
    candidates: RerankCandidate[],
  ): Promise<Map<string, number>>;
}

const terms = (value: string): Set<string> =>
  new Set(
    value
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length > 1) ?? [],
  );

/** 无额外模型费用的确定性重排器，后续可以通过同一端口替换为 Cross Encoder。 */
export class LexicalReranker implements RerankerPort {
  async rerank(
    query: string,
    candidates: RerankCandidate[],
  ): Promise<Map<string, number>> {
    const queryTerms = terms(query);
    const scores = new Map<string, number>();
    for (const candidate of candidates) {
      const contentTerms = terms(candidate.content);
      const overlap = [...queryTerms].filter((term) =>
        contentTerms.has(term),
      ).length;
      const coverage = queryTerms.size === 0 ? 0 : overlap / queryTerms.size;
      scores.set(candidate.id, coverage + candidate.fusionScore);
    }
    return scores;
  }
}
