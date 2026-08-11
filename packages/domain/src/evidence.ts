import { z } from "zod";

export const EvidenceSourceTypeSchema = z.enum(["web", "document"]);

export const EvidenceSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  ownerId: z.string().min(1),
  claim: z.string().min(1),
  sourceType: EvidenceSourceTypeSchema,
  sourceUrl: z.string().url().nullable(),
  sourceTitle: z.string().min(1).nullable(),
  publisher: z.string().min(1).nullable(),
  publishedAt: z.date().nullable(),
  retrievedAt: z.date(),
  quote: z.string().min(1),
  documentId: z.string().uuid().nullable(),
  page: z.number().int().positive().nullable(),
  confidence: z.number().min(0).max(1),
  contentHash: z.string().min(1).max(128),
});

export type EvidenceSourceType = z.infer<typeof EvidenceSourceTypeSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
