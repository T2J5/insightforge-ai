import {
  DocumentChunkMetadataSchema,
  RetrievedChunkSchema,
  SearchDocumentsInputSchema,
  type EmbeddingPort,
  type RetrievedChunk,
  type SearchDocumentsInput,
} from "@insightforge/domain";

import { LexicalReranker, type RerankerPort } from "./reranker";
import { rrf } from "./rrf";

export interface RetrievalCandidate {
  id: string;
  documentId: string;
  title: string;
  content: string;
  metadata: unknown;
  score: number;
}

export interface RetrievalStore {
  lexicalSearch(input: {
    ownerId: string;
    documentIds: string[];
    query: string;
    limit: number;
  }): Promise<RetrievalCandidate[]>;
  vectorSearch(input: {
    ownerId: string;
    documentIds: string[];
    embedding: number[];
    limit: number;
  }): Promise<RetrievalCandidate[]>;
}

export class HybridRetriever {
  constructor(
    private readonly store: RetrievalStore,
    private readonly embeddings: EmbeddingPort,
    private readonly reranker: RerankerPort = new LexicalReranker(),
  ) {}

  async search(
    untrustedInput: SearchDocumentsInput,
  ): Promise<RetrievedChunk[]> {
    const input = SearchDocumentsInputSchema.parse(untrustedInput);
    const [queryEmbedding] = await this.embeddings.embed([input.query]);
    if (
      !queryEmbedding ||
      queryEmbedding.length !== this.embeddings.dimensions
    ) {
      throw new Error("EMBEDDING_DIMENSION_MISMATCH");
    }

    const common = {
      ownerId: input.ownerId,
      documentIds: input.documentIds,
      limit: 30,
    };
    /**
     * 两路召回并行执行；ownerId/documentIds 必须进入两路 SQL，
     * 不能查询后才在 Node.js 中过滤越权数据。
     */
    const [lexical, vector] = await Promise.all([
      this.store.lexicalSearch({ ...common, query: input.query }),
      this.store.vectorSearch({ ...common, embedding: queryEmbedding }),
    ]);
    const byId = new Map(
      [...lexical, ...vector].map((candidate) => [candidate.id, candidate]),
    );
    const lexicalScores = new Map(lexical.map((item) => [item.id, item.score]));
    const vectorScores = new Map(vector.map((item) => [item.id, item.score]));
    /** 两路原始分数不在同一量纲，RRF 只融合排名，不直接相加分数。 */
    const fused = rrf(
      [lexical.map((item) => item.id), vector.map((item) => item.id)],
      60,
    ).slice(0, 20);
    /** 只重排融合前 20 条，控制延迟以及未来模型重排的费用。 */
    const rerankerScores = await this.reranker.rerank(
      input.query,
      fused.flatMap((item) => {
        const candidate = byId.get(item.id);
        return candidate
          ? [
              {
                id: item.id,
                content: candidate.content,
                fusionScore: item.score,
              },
            ]
          : [];
      }),
    );

    return fused
      .flatMap((item) => {
        const candidate = byId.get(item.id);
        if (!candidate) return [];
        return [
          RetrievedChunkSchema.parse({
            id: candidate.id,
            documentId: candidate.documentId,
            title: candidate.title,
            content: candidate.content,
            metadata: DocumentChunkMetadataSchema.parse(candidate.metadata),
            lexicalScore: lexicalScores.get(item.id) ?? null,
            vectorScore: vectorScores.get(item.id) ?? null,
            fusionScore: item.score,
            rerankerScore: rerankerScores.get(item.id) ?? item.score,
          }),
        ];
      })
      .sort(
        (left, right) =>
          right.rerankerScore - left.rerankerScore ||
          right.fusionScore - left.fusionScore ||
          left.id.localeCompare(right.id),
      )
      .slice(0, input.limit);
  }
}
