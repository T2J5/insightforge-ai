import { createOpenAI } from "@ai-sdk/openai";
import {
  AiSdkStructuredModel,
  type AiSdkStructuredModelOptions,
} from "./ai-sdk-structured-model";

export interface CreateOpenAiStructuredModelOptions extends Omit<
  AiSdkStructuredModelOptions,
  "model"
> {
  apiKey: string;
  modelName: string;
  baseUrl?: string;
}

/**
 * 创建使用 OpenAI Chat Completions API 的
 * StructuredModel。
 */
export const createOpenAiStructuredModel = (
  options: CreateOpenAiStructuredModelOptions,
) => {
  const apiKey = options.apiKey.trim();
  const modelName = options.modelName.trim();
  const baseUrl = options.baseUrl?.trim() || undefined;
  if (apiKey.length === 0) {
    throw new Error("MODEL_API_KEY_REQUIRED");
  }

  if (modelName.length === 0) {
    throw new Error("MODEL_NAME_REQUIRED");
  }
  const openai = createOpenAI({
    apiKey,
    /**
     * 未配置时，Provider 使用官方 OpenAI 地址。
     */
    ...(baseUrl ? { baseURL: baseUrl } : {}),
  });

  return new AiSdkStructuredModel({
    model: openai.responses(modelName),
    maxRetries: options.maxRetries,
    timeoutMs: options.timeoutMs,
    maxOutputTokens: options.maxOutputTokens,
    inputCostCnyPerMillionTokens: options.inputCostCnyPerMillionTokens,
    outputCostCnyPerMillionTokens: options.outputCostCnyPerMillionTokens,
  });
};
