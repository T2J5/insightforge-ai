export type ModelInput = {
  operation: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
};

export type ModelResult<T> = {
  value: T;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costCny: number;
  };
};

export interface StructuredModel {
  generate<T>(
    schema: import("zod").ZodType<T>,
    input: ModelInput,
  ): Promise<ModelResult<T>>;
}
