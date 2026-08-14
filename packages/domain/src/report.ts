/**
 * 负责定义：
报告版本状态；
创建一个报告版本需要的数据；
数据库返回的完整版本；
报告结构化内容。
*/

import { z } from "zod";

import { JsonObjectSchema } from "./research";

/**
 * 报告版本状态。
 *
 * draft：内部草稿，不能通过公开接口返回
 * published：已发布版本
 */
export const ReportVersionStatusSchema = z.enum(["draft", "published"]);

export type ReportVersionStatus = z.infer<typeof ReportVersionStatusSchema>;

/**
 * Task 2阶段暂时把报告正文定义为JSON对象。
 *
 * Task 7实现Writer和Reviewer时，再进一步收紧为：
 * section、block、claimType和citationIds等具体结构。
 */
export const ReportContentSchema = JsonObjectSchema;

export type ReportContent = z.infer<typeof ReportContentSchema>;

/**
 * 创建新报告版本时需要的数据。
 */
export const CreateReportVersionSchema = z.object({
  /**
   * 可选ID方便测试或上层预生成ID。
   * 未提供时由数据库生成。
   */
  id: z.uuid().optional(),

  reportId: z.uuid(),

  runId: z.uuid(),

  ownerId: z.string().trim().min(1).max(128),

  content: ReportContentSchema,

  status: ReportVersionStatusSchema,

  qualityWarning: z.string().trim().min(1).max(4_000).nullable().default(null),
});

export type CreateReportVersion = z.infer<typeof CreateReportVersionSchema>;

/**
 * 数据库返回的完整报告版本。
 */
export const ReportVersionSchema = z
  .object({
    id: z.uuid(),

    reportId: z.uuid(),

    runId: z.uuid(),

    ownerId: z.string().trim().min(1).max(128),

    version: z.int().positive(),

    content: ReportContentSchema,

    status: ReportVersionStatusSchema,

    qualityWarning: z.string().trim().min(1).max(4_000).nullable(),

    createdAt: z.date(),

    publishedAt: z.date().nullable(),
  })
  .superRefine((report, context) => {
    if (report.status === "published" && report.publishedAt === null) {
      context.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "已发布报告必须包含 publishedAt",
      });
    }

    if (report.status === "draft" && report.publishedAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "草稿报告不能包含 publishedAt",
      });
    }
  });

export type ReportVersion = z.infer<typeof ReportVersionSchema>;
