import type { ZodType } from "zod";

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
