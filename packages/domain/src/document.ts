import { z } from "zod";

export const SupportedDocumentTypeSchema = z.enum([
  "pdf",
  "docx",
  "markdown",
  "text",
]);
export type SupportedDocumentType = z.infer<typeof SupportedDocumentTypeSchema>;

export const DocumentStatusSchema = z.enum([
  "pending",
  "processing",
  "ready",
  "failed",
]);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const ParsedDocumentPageSchema = z
  .object({
    pageNumber: z.int().positive(),
    headings: z.array(z.string().trim().min(1).max(500)).max(12),
    text: z.string().trim().min(1),
  })
  .strict();

export const ParsedDocumentSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    pages: z.array(ParsedDocumentPageSchema).min(1),
  })
  .strict();
export type ParsedDocument = z.infer<typeof ParsedDocumentSchema>;

export const DocumentChunkMetadataSchema = z
  .object({
    pageStart: z.int().positive(),
    pageEnd: z.int().positive(),
    headingPath: z.array(z.string().trim().min(1).max(500)).max(12),
  })
  .strict()
  .refine((value) => value.pageEnd >= value.pageStart, {
    path: ["pageEnd"],
    message: "pageEnd must be greater than or equal to pageStart",
  });
export type DocumentChunkMetadata = z.infer<typeof DocumentChunkMetadataSchema>;

export const RetrievedChunkSchema = z
  .object({
    id: z.uuid(),
    documentId: z.uuid(),
    title: z.string().trim().min(1).max(500),
    content: z.string().trim().min(1),
    metadata: DocumentChunkMetadataSchema,
    lexicalScore: z.number().finite().nonnegative().nullable(),
    vectorScore: z.number().finite().min(-1).max(1).nullable(),
    fusionScore: z.number().finite().nonnegative(),
    rerankerScore: z.number().finite(),
  })
  .strict();
export type RetrievedChunk = z.infer<typeof RetrievedChunkSchema>;

export const SearchDocumentsInputSchema = z
  .object({
    ownerId: z.string().trim().min(1).max(128),
    documentIds: z.array(z.uuid()).max(10).default([]),
    query: z.string().trim().min(1).max(1_000),
    limit: z.int().min(1).max(20).default(8),
  })
  .strict();
export type SearchDocumentsInput = z.infer<typeof SearchDocumentsInputSchema>;

export interface EmbeddingPort {
  dimensions: number;
  embed(inputs: string[]): Promise<number[][]>;
}
