import type { ZodType } from "zod";

export type ModelInput = {
  operation: string;
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
