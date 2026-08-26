import type { ZodType } from "zod";
import { generateText, Output, type LanguageModel } from "ai";
import type {
  ModelInput,
  ModelResult,
  StructuredModel,
} from "@insightforge/domain";

/**
 * AI SDK 模型适配器配置。
 *
 * model：
 * 已经由具体 Provider 创建的模型实例。
 *
 * 价格字段：
 * 按每 100 万 Token 的人民币成本配置。
 * 没有配置时默认记为 0。
 */
export interface AiSdkStructuredModelOptions {
  model: LanguageModel;
  maxRetries?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  inputCostCnyPerMillionTokens?: number;
  outputCostCnyPerMillionTokens?: number;
}
const assertNonNegativeNumber = (value: number, errCode: string) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(errCode);
  }
};
const assertPositiveInteger = (value: number, errorCode: string): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(errorCode);
  }
};

/**
 * 将 AI SDK LanguageModel 适配为项目的 StructuredModel。
 *
 * Graph 只依赖 StructuredModel，不知道底层使用：
 *
 * - OpenAI；
 * - Anthropic；
 * - Google；
 * - 其他 AI SDK Provider。
 */
export class AiSdkStructuredModel implements StructuredModel {
  private readonly model: LanguageModel;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly inputCostCnyPerMillionTokens: number;
  private readonly outputCostCnyPerMillionTokens: number;

  constructor(options: AiSdkStructuredModelOptions) {
    const maxRetries = options.maxRetries ?? 2;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxOutputTokens = options.maxOutputTokens ?? 8_000;
    const inputCost = options.inputCostCnyPerMillionTokens ?? 0;
    const outputCost = options.outputCostCnyPerMillionTokens ?? 0;

    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
      throw new Error("MODEL_MAX_RETRIES_INVALID");
    }

    assertPositiveInteger(timeoutMs, "MODEL_TIMEOUT_INVALID");
    assertPositiveInteger(maxOutputTokens, "MODEL_MAX_OUTPUT_TOKENS_INVALID");
    assertNonNegativeNumber(inputCost, "MODEL_INPUT_COST_INVALID");
    assertNonNegativeNumber(outputCost, "MODEL_OUTPUT_COST_INVALID");

    this.model = options.model;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.maxOutputTokens = maxOutputTokens;
    this.inputCostCnyPerMillionTokens = inputCost;
    this.outputCostCnyPerMillionTokens = outputCost;
  }

  async generate<T>(
    schema: ZodType<T>,
    input: ModelInput,
  ): Promise<ModelResult<T>> {
    /**
     * AI SDK 推荐把 system instruction
     * 放在独立的 system 字段中。
     *
     * 当前项目的 ModelInput 把所有消息放在数组里，
     * 所以这里负责拆分。
     */
    const systemMessages = input.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content);

    const system =
      systemMessages.length > 0 ? systemMessages.join("\n\n") : undefined;

    /**
     * AI SDK messages 中只保留
     * user 和 assistant 消息。
     */
    const messages: Array<
      { role: "user"; content: string } | { role: "assistant"; content: string }
    > = [];
    for (const message of input.messages) {
      if (message.role === "system") {
        continue;
      }
      messages.push({
        role: message.role,
        content: message.content,
      });
    }
    if (messages.length === 0) {
      throw new Error("MODEL_CONVERSATION_REQUIRED");
    }

    const requestedTimeoutMs = input.timeoutMs ?? this.timeoutMs;
    assertPositiveInteger(requestedTimeoutMs, "MODEL_TIMEOUT_INVALID");
    const effectiveTimeoutMs = Math.min(requestedTimeoutMs, this.timeoutMs);

    const result = await generateText({
      model: this.model,
      system,
      messages,
      /**
       * AI SDK 7 的结构化输出入口。
       *
       * AI SDK 会把 Zod Schema 转换成
       * Provider 支持的 JSON Schema，
       * 并校验模型最终输出。
       */
      output: Output.object({
        schema,
        name: input.operation,
        description: `Structured output for ${input.operation}`,
      }),
      maxRetries: this.maxRetries,
      timeout: effectiveTimeoutMs,
      maxOutputTokens: this.maxOutputTokens,
    });

    if (result.finishReason !== "stop") {
      throw new Error(
        [
          "MODEL_OUTPUT_INCOMPLETE",
          `operation=${input.operation}`,
          `finishReason=${result.finishReason}`,
          `rawFinishReason=${result.rawFinishReason ?? "unknown"}`,
          `outputTokens=${result.usage.outputTokens ?? 0}`,
        ].join(" "),
      );
    }
    /**
     * Provider 有时可能不返回 Token Usage，
     * 因此使用 0 作为缺失值。
     */
    const inputTokens = result.usage.inputTokens ?? 0;
    const outputTokens = result.usage.outputTokens ?? 0;
    const costCny =
      (inputTokens / 1_000_000) * this.inputCostCnyPerMillionTokens +
      (outputTokens / 1_000_000) * this.outputCostCnyPerMillionTokens;

    return {
      /**
       * AI SDK 已经进行过 Schema 校验。
       *
       * 再 parse 一次是项目端口的防御性校验：
       * StructuredModel 永远只返回符合调用方
       * Zod Schema 的数据。
       */
      value: schema.parse(result.output),
      usage: {
        inputTokens,
        outputTokens,
        costCny,
      },
    };
  }
}
