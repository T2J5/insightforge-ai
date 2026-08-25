import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { AiSdkStructuredModel } from "./ai-sdk-structured-model";
import { createOpenAiStructuredModel } from "./openai-structured-model";

const usage = {
  inputTokens: {
    total: 1_000,
    noCache: 1_000,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: {
    total: 500,
    text: 500,
    reasoning: 0,
  },
};

const createMockModel = (output: unknown) =>
  new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: "text", text: JSON.stringify(output) }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    },
  });

describe("AiSdkStructuredModel", () => {
  it("returns schema-validated structured data and calculated usage", async () => {
    const languageModel = createMockModel({ answer: "verified" });
    const model = new AiSdkStructuredModel({
      model: languageModel,
      inputCostCnyPerMillionTokens: 2,
      outputCostCnyPerMillionTokens: 6,
    });

    const result = await model.generate(z.object({ answer: z.string() }), {
      operation: "answer-question",
      messages: [
        { role: "system", content: "Only use supplied evidence." },
        { role: "user", content: "Answer the question." },
      ],
    });

    expect(result).toEqual({
      value: { answer: "verified" },
      usage: {
        inputTokens: 1_000,
        outputTokens: 500,
        costCny: 0.005,
      },
    });
    expect(languageModel.doGenerateCalls).toHaveLength(1);
    expect(languageModel.doGenerateCalls[0]?.prompt).toEqual([
      {
        role: "system",
        content: "Only use supplied evidence.",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Answer the question." }],
      },
    ]);
    expect(languageModel.doGenerateCalls[0]?.responseFormat?.type).toBe("json");
  });

  it("joins multiple system messages without sending them as conversation messages", async () => {
    const languageModel = createMockModel({ answer: "ok" });
    const model = new AiSdkStructuredModel({ model: languageModel });

    await model.generate(z.object({ answer: z.string() }), {
      operation: "answer-question",
      messages: [
        { role: "system", content: "Rule one." },
        { role: "system", content: "Rule two." },
        { role: "user", content: "Question" },
        { role: "assistant", content: "Earlier answer" },
      ],
    });

    expect(languageModel.doGenerateCalls[0]?.prompt[0]).toEqual({
      role: "system",
      content: "Rule one.\n\nRule two.",
    });
    expect(languageModel.doGenerateCalls[0]?.prompt).toHaveLength(3);
  });

  it("rejects calls that contain no user or assistant conversation", async () => {
    const model = new AiSdkStructuredModel({
      model: createMockModel({ answer: "unused" }),
    });

    await expect(
      model.generate(z.object({ answer: z.string() }), {
        operation: "answer-question",
        messages: [{ role: "system", content: "System only" }],
      }),
    ).rejects.toThrow("MODEL_CONVERSATION_REQUIRED");
  });

  it("rejects model output that violates the caller schema", async () => {
    const model = new AiSdkStructuredModel({
      model: createMockModel({ answer: 42 }),
      maxRetries: 0,
    });

    await expect(
      model.generate(z.object({ answer: z.string() }), {
        operation: "answer-question",
        messages: [{ role: "user", content: "Question" }],
      }),
    ).rejects.toThrow();
  });

  it.each([
    [{ maxRetries: -1 }, "MODEL_MAX_RETRIES_INVALID"],
    [{ maxRetries: 1.5 }, "MODEL_MAX_RETRIES_INVALID"],
    [{ timeoutMs: 0 }, "MODEL_TIMEOUT_INVALID"],
    [{ maxOutputTokens: 1.5 }, "MODEL_MAX_OUTPUT_TOKENS_INVALID"],
    [{ inputCostCnyPerMillionTokens: -1 }, "MODEL_INPUT_COST_INVALID"],
    [
      { outputCostCnyPerMillionTokens: Number.NaN },
      "MODEL_OUTPUT_COST_INVALID",
    ],
  ])("rejects invalid adapter options %j", (invalidOptions, errorCode) => {
    expect(
      () =>
        new AiSdkStructuredModel({
          model: createMockModel({ answer: "unused" }),
          ...invalidOptions,
        }),
    ).toThrow(errorCode);
  });
});

describe("createOpenAiStructuredModel", () => {
  it("rejects an empty API key before creating the provider", () => {
    expect(() =>
      createOpenAiStructuredModel({ apiKey: "   ", modelName: "test-model" }),
    ).toThrow("MODEL_API_KEY_REQUIRED");
  });

  it("rejects an empty model name before creating the provider", () => {
    expect(() =>
      createOpenAiStructuredModel({ apiKey: "test-key", modelName: "   " }),
    ).toThrow("MODEL_NAME_REQUIRED");
  });
});
