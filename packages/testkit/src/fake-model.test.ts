import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FakeStructuredModel } from "./fake-model";

describe("FakeStructuredModel", () => {
  it("returns queued structured responses and records calls", async () => {
    const model = new FakeStructuredModel([{ answer: "ByteDance" }]);

    const result = await model.generate(z.object({ answer: z.string() }), {
      operation: "extract-company",
      messages: [{ role: "user", content: "Company?" }],
    });

    expect(result.value.answer).toBe("ByteDance");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.operation).toBe("extract-company");
  });
});
