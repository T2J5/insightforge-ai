import {
  RetrievedChunkSchema,
  type RetrievedChunk,
} from "@insightforge/domain";
import { z } from "zod";

export const SearchUploadedDocumentsInputSchema = z
  .object({
    query: z.string().trim().min(1).max(1_000),
    documentIds: z.array(z.uuid()).max(10).default([]),
    limit: z.int().min(1).max(20).default(8),
  })
  .strict();

export interface DocumentSearchContext {
  /** ownerId 来自认证上下文，不能由模型参数提供。 */
  ownerId: string;
}

export interface UploadedDocumentRetriever {
  search(input: {
    ownerId: string;
    query: string;
    documentIds: string[];
    limit: number;
  }): Promise<RetrievedChunk[]>;
}

export class SearchUploadedDocumentsTool {
  constructor(private readonly retriever: UploadedDocumentRetriever) {}

  async execute(context: DocumentSearchContext, untrustedInput: unknown) {
    const input = SearchUploadedDocumentsInputSchema.parse(untrustedInput);
    const results = await this.retriever.search({
      ownerId: context.ownerId,
      query: input.query,
      documentIds: input.documentIds,
      limit: input.limit,
    });
    return z.array(RetrievedChunkSchema).max(20).parse(results);
  }
}
