import { z } from "zod";

export const ReportVersionStatusSchema = z.enum(["draft", "published"]);

export const CreateReportVersionSchema = z.object({
  id: z.string().uuid().optional(),
  reportId: z.string().uuid(),
  runId: z.string().uuid(),
  ownerId: z.string().min(1),
  content: z.record(z.unknown()),
  status: ReportVersionStatusSchema,
  qualityWarning: z.string().nullable().default(null),
});

export const ReportVersionSchema = CreateReportVersionSchema.extend({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.date(),
  publishedAt: z.date().nullable(),
});

export type ReportVersionStatus = z.infer<
  typeof ReportVersionStatusSchema
>;
export type CreateReportVersion = z.input<typeof CreateReportVersionSchema>;
export type ReportVersion = z.infer<typeof ReportVersionSchema>;
