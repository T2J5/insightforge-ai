import { z } from "zod";

export const ResearchFocusSchema = z.enum([
  "comprehensive",
  "product",
  "technology",
  "business",
  "competition",
]);

export const ResearchDepthSchema = z.enum(["quick", "deep"]);

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
]);

export const CreateResearchRunSchema = z.object({
  ownerId: z.string().min(1),
  company: z.string().trim().min(2).max(120),
  focus: ResearchFocusSchema,
  depth: ResearchDepthSchema,
});

export const ResearchRunSchema = CreateResearchRunSchema.extend({
  id: z.string().uuid(),
  status: RunStatusSchema,
  tokenUsage: z.number().int().nonnegative(),
  estimatedCostCny: z.number().nonnegative(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const RunCheckpointInputSchema = z.object({
  checkpointKey: z.string().trim().min(1).max(120),
  state: z.record(z.unknown()),
});

export const RunCheckpointSchema = RunCheckpointInputSchema.extend({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ResearchFocus = z.infer<typeof ResearchFocusSchema>;
export type ResearchDepth = z.infer<typeof ResearchDepthSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type CreateResearchRun = z.infer<typeof CreateResearchRunSchema>;
export type ResearchRun = z.infer<typeof ResearchRunSchema>;
export type RunCheckpointInput = z.infer<typeof RunCheckpointInputSchema>;
export type RunCheckpoint = z.infer<typeof RunCheckpointSchema>;
