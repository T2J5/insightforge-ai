import { describe, expect, it } from "vitest";
import type { EmbeddingPort } from "@insightforge/domain";
import { HybridRetriever, type RetrievalStore } from "./search";
import { rrf } from "./rrf";

const id = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
const candidate = (suffix: string, score: number) => ({
  id: id(suffix),
  documentId: id("99"),
  title: "Private strategy",
  content: `acquisition strategy ${suffix}`,
  metadata: { pageStart: 1, pageEnd: 1, headingPath: ["Strategy"] },
  score,
});
const embeddings: EmbeddingPort = {
  dimensions: 3,
  async embed() {
    return [[1, 0, 0]];
  },
};

describe("rrf", () => {
  it("确定性融合关键词和向量排名", () => {
    expect(
      rrf(
        [
          ["a", "b"],
          ["b", "c"],
        ],
        60,
      ).map((item) => item.id),
    ).toEqual(["b", "a", "c"]);
  });
});

describe("HybridRetriever", () => {
  it("把 ownerId 和 documentIds 强制传给两路检索并返回评分结构", async () => {
    const calls: unknown[] = [];
    const store: RetrievalStore = {
      async lexicalSearch(input) {
        calls.push(input);
        return [candidate("01", 0.8), candidate("02", 0.7)];
      },
      async vectorSearch(input) {
        calls.push(input);
        return [candidate("02", 0.9), candidate("03", 0.6)];
      },
    };
    const result = await new HybridRetriever(store, embeddings).search({
      ownerId: "user-a",
      documentIds: [id("99")],
      query: "acquisition strategy",
      limit: 8,
    });
    expect(calls).toEqual([
      expect.objectContaining({
        ownerId: "user-a",
        documentIds: [id("99")],
        limit: 30,
      }),
      expect.objectContaining({
        ownerId: "user-a",
        documentIds: [id("99")],
        limit: 30,
      }),
    ]);
    expect(result[0]).toMatchObject({
      id: id("02"),
      lexicalScore: 0.7,
      vectorScore: 0.9,
    });
    expect(result[0]?.fusionScore).toBeGreaterThan(0);
  });

  it("另一个 owner 没有候选时绝不返回私有 chunk", async () => {
    const store: RetrievalStore = {
      async lexicalSearch() {
        return [];
      },
      async vectorSearch() {
        return [];
      },
    };
    await expect(
      new HybridRetriever(store, embeddings).search({
        ownerId: "user-a",
        documentIds: [],
        query: "private acquisition plan",
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });
});
