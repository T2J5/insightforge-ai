import { z } from "zod";

/**
 * Agent 工作流内部使用的证据 ID。
 *
 * ID 由服务端在 grounding 完成后分配，
 * 模型不能生成。
 *
 * 示例：
 *
 * E1
 * E2
 * E12
 */
export const EvidenceIdSchema = z.string().regex(/^E[1-9]\d*$/);
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;

/**
 * 模型提出的候选证据。
 *
 * 注意：
 * 这只是模型输出，还没有经过服务端的引用校验。
 */
export const EvidenceCandidateDraftSchema = z
  .object({
    /**
     * 证据支持哪个调研问题。
     */
    questionId: z.string().trim().min(1).max(50),
    /**
     * 根据原文证据可以支持的结论。
     *
     * claim 可以是模型对原文的归纳，
     * 不要求逐字存在于正文。
     */
    claim: z.string().trim().min(1).max(4_000),
    /**
     * 必须使用输入资料中已有的 URL。
     */
    sourceUrl: z.string().trim().min(1).max(2_048),
    /**
     * 必须从来源正文中逐字复制。
     */
    quote: z.string().trim().min(1).max(1_200),
    /**
     * 模型对“quote 是否充分支持 claim”
     * 给出的置信度。
     */
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

export type EvidenceCandidateDraft = z.infer<
  typeof EvidenceCandidateDraftSchema
>;

/**
 * Evidence Extractor 模型调用的结构化输出。
 *
 * 允许空数组：
 * 如果材料不能支持任何事实，
 * 模型应该返回空数组，而不是编造。
 */
export const EvidenceExtractionModelOutputSchema = z
  .object({
    candidates: z.array(EvidenceCandidateDraftSchema).max(12),
  })
  .strict();

export type EvidenceExtractionModelOutput = z.infer<
  typeof EvidenceExtractionModelOutputSchema
>;

/**
 * 经过服务端验证的 EvidenceCandidate。
 *
 * sourceTitle 不让模型生成，
 * 而是从已经验证过的 ResearchSource 中补充。
 */
export const EvidenceCandidateSchema = z
  .object({
    /**
     * 服务端分配的工作流内证据 ID。
     */
    evidenceId: EvidenceIdSchema,
    questionId: z.string().trim().min(1).max(50),
    claim: z.string().trim().min(1).max(4_000),
    sourceUrl: z.url(),
    sourceTitle: z.string().trim().min(1).max(500),
    publisher: z.string().trim().min(1).max(300).nullable().optional(),
    publishedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    retrievedAt: z.iso.datetime({ offset: true }).optional(),
    quote: z.string().trim().min(1).max(1_200),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();
export type EvidenceCandidate = z.infer<typeof EvidenceCandidateSchema>;
