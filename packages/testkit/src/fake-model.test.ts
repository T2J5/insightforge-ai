import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FakeStructuredModel } from "./fake-model";

describe("FakeStructuredModel", () => {
  it("按队列顺序返回结构化响应并记录调用", async () => {
    const model = new FakeStructuredModel([{ answer: "ByteDance" }]);

    const result = await model.generate(z.object({ answer: z.string() }), {
      operation: "extract-company",
      messages: [{ role: "user", content: "Company?" }],
    });

    expect(result.value.answer).toBe("ByteDance");
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costCny: 0,
    });
    expect(model.calls).toEqual([
      {
        operation: "extract-company",
        messages: [{ role: "user", content: "Company?" }],
      },
    ]);
  });

  it("没有预置响应时抛出包含操作名的错误", async () => {
    const model = new FakeStructuredModel([]);

    await expect(
      model.generate(z.object({ answer: z.string() }), {
        operation: "extract-company",
        messages: [],
      }),
    ).rejects.toThrow("No fake response queued for extract-company");
  });

  it("使用调用方传入的 Zod Schema 校验响应", async () => {
    const model = new FakeStructuredModel([{ answer: 123 }]);

    await expect(
      model.generate(z.object({ answer: z.string() }), {
        operation: "extract-company",
        messages: [],
      }),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});
