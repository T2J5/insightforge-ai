/**
 * 标准化证据

  负责定义从网页或上传文档提取出来的证据。
  一条证据包含：
    它支持什么结论；
    来源是什么；
    原文引文是什么；
    属于哪次调研；
    属于哪个用户；
    可信度是多少；
    如何去重。
*/

import { z } from "zod";

/**
 * 证据来源类型。
 *
 * web：公开网页
 * document：用户上传文档
 */
export const EvidenceSourceTypeSchema = z.enum(["web", "document"]);

export type EvidenceSourceType = z.infer<typeof EvidenceSourceTypeSchema>;

export const validateEvidenceSourceConsistency = (
  evidence: {
    sourceType: "web" | "document";
    sourceUrl: string | null;
    documentId: string | null;
  },
  ctx: z.RefinementCtx,
) => {
  if (evidence.sourceType === "web" && evidence.sourceUrl === null) {
    ctx.addIssue({
      code: "custom",
      path: ["sourceUrl"],
      message: "网页证据必须包含 sourceUrl",
    });
  }

  if (evidence.sourceType === "document" && evidence.documentId === null) {
    ctx.addIssue({
      code: "custom",
      path: ["documentId"],
      message: "文档证据必须包含 documentId",
    });
  }

  if (evidence.sourceType === "web" && evidence.documentId !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["documentId"],
      message: "网页证据不能关联 documentId",
    });
  }
};
/**
 * 标准化证据。
 *
 * 同一结构同时支持网页证据和用户文档证据。
 */
export const EvidenceSchema = z
  .object({
    id: z.uuid(),

    runId: z.uuid(),

    ownerId: z.string().trim().min(1).max(128),

    /**
     * 由这条证据支持的标准化结论。
     */
    claim: z.string().trim().min(1).max(4_000),

    sourceType: EvidenceSourceTypeSchema,

    /**
     * 文档证据可能没有公开URL，因此允许为空。
     */
    sourceUrl: z.url().nullable(),

    sourceTitle: z.string().trim().min(1).max(500).nullable(),

    publisher: z.string().trim().min(1).max(300).nullable(),

    /**
     * 某些网页没有可靠的发布时间。
     */
    publishedAt: z.date().nullable(),

    retrievedAt: z.date(),

    /**
     * 必须能够回溯到原始网页或文档的原文片段。
     */
    quote: z.string().trim().min(1).max(10_000),

    /**
     * 网页证据通常没有documentId；
     * 上传文档证据必须有documentId。
     */
    documentId: z.uuid().nullable(),

    /**
     * 网页或无页码文档可能没有page。
     */
    page: z.int().positive().nullable(),

    confidence: z.number().min(0).max(1),

    /**
     * 用于幂等保存和证据去重。
     * 暂定为SHA-256，即64位十六进制字符串。
     */
    contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .superRefine(validateEvidenceSourceConsistency);

export type Evidence = z.infer<typeof EvidenceSchema>;
