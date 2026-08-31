import { z, type ZodType } from "zod";

export type ModelInput = {
  operation: string;
  /**
   * 本次调用允许使用的最长时间。
   *
   * Adapter 还会与自己的全局 timeout 取最小值。
   */
  timeoutMs?: number;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  costCny: number;
};

export type ModelResult<T> = {
  value: T;
  usage: ModelUsage;
};

export interface StructuredModel {
  generate<T>(schema: ZodType<T>, input: ModelInput): Promise<ModelResult<T>>;
}

export const PublicHttpUrlSchema = z.url().refine(
  (value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  },
  { message: "URL must use HTTP or HTTPS" },
);

/**
 * 标准化搜索结果。
 *
 * url：
 * 搜索服务返回的原始 URL。
 *
 * canonicalUrl：
 * 项目规范化后的 URL，用于去重和证据关联。
 */
export const SearchHitSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    url: PublicHttpUrlSchema,
    canonicalUrl: PublicHttpUrlSchema,
    snippet: z.string().trim().min(1).max(1_200),
    score: z.number().finite().min(0).max(1),
    publishedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchWebInputSchema = z
  .object({
    query: z.string().trim().min(1).max(1_000),
    limit: z.int().min(1).max(10),
    timeoutMs: z.int().positive().optional(),
  })
  .strict();
export type SearchWebInput = z.infer<typeof SearchWebInputSchema>;

/**
 * 与具体搜索供应商无关的搜索端口。
 */
export interface WebSearchPort {
  search(input: SearchWebInput): Promise<SearchHit[]>;
}
/**
 * 已抓取并清洗的网页。
 *
 * content 的字节限制由抓取器在读取响应流时执行，
 * 不能只依赖字符串字符数量。
 */
export const FetchedPageSchema = z
  .object({
    canonicalUrl: PublicHttpUrlSchema,
    title: z.string().trim().min(1).max(500),
    publisher: z.string().trim().min(1).max(300).nullable(),
    publishedAt: z.iso.datetime({ offset: true }).nullable(),
    fetchedAt: z.iso.datetime({ offset: true }),
    content: z.string().trim().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    httpStatus: z.int().min(100).max(599),
    contentType: z.string().trim().min(1).max(200),
  })
  .strict();

export type FetchedPage = z.infer<typeof FetchedPageSchema>;

export const FetchWebPageInputSchema = z
  .object({
    url: PublicHttpUrlSchema,
    timeoutMs: z.int().positive().optional(),
  })
  .strict();

export type FetchWebPageInput = z.infer<typeof FetchWebPageInputSchema>;

/**
 * 网页抓取端口。
 *
 * 重定向、响应大小、超时和重试策略属于具体 Adapter。
 */
export interface WebPagePort {
  fetch(input: FetchWebPageInput): Promise<FetchedPage>;
}
