import { describe, expect, it, vi } from "vitest";
import { OpenAiEmbeddingModel } from "./openai-embeddings";

describe("OpenAiEmbeddingModel", () => {
  it("按供应商 index 恢复输入顺序并校验维度", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0, 1, 0] },
              { index: 0, embedding: [1, 0, 0] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const model = new OpenAiEmbeddingModel({
      apiKey: "test-key",
      dimensions: 3,
      fetch,
    });
    await expect(model.embed(["a", "b"])).resolves.toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  it("拒绝错误维度，防止 pgvector 写入阶段才失败", async () => {
    const model = new OpenAiEmbeddingModel({
      apiKey: "test-key",
      dimensions: 3,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [{ index: 0, embedding: [1] }] }),
            {
              status: 200,
            },
          ),
      ),
    });
    await expect(model.embed(["a"])).rejects.toThrow(
      "EMBEDDING_DIMENSION_MISMATCH",
    );
  });
});
