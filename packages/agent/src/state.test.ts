import { END, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { ResearchAgentState } from "./state";

const runId = "550e8400-e29b-41d4-a716-446655440000";
const startedAt = "2026-08-25T00:00:00.000Z";
const deadlineAt = "2026-08-25T00:05:00.000Z";

const input = {
  runId,
  company: "ByteDance",
  focus: "technology" as const,
  depth: "quick" as const,
  startedAt,
  deadlineAt,
};

const createReducerGraph = () =>
  new StateGraph(ResearchAgentState)
    .addNode("firstResearchBatch", () => ({
      searchCount: 2,
      completedQuestionIds: ["q1", "q2"],
    }))
    .addNode("secondResearchBatch", () => ({
      searchCount: 1,
      completedQuestionIds: ["q2", "q3"],
    }))
    .addEdge(START, "firstResearchBatch")
    .addEdge("firstResearchBatch", "secondResearchBatch")
    .addEdge("secondResearchBatch", END)
    .compile();

describe("ResearchAgentState", () => {
  it("保留可恢复运行上下文并累计搜索次数", async () => {
    const result = await createReducerGraph().invoke(input);

    expect(result).toMatchObject({
      runId,
      startedAt,
      deadlineAt,
      searchCount: 3,
    });
  });

  it("追加已完成问题并对重试产生的 ID 去重", async () => {
    const result = await createReducerGraph().invoke(input);

    expect(result.completedQuestionIds).toEqual(["q1", "q2", "q3"]);
  });

  it.each([
    ["非法 runId", { ...input, runId: "not-a-uuid" }],
    ["非法开始时间", { ...input, startedAt: "not-a-date" }],
    ["非法截止时间", { ...input, deadlineAt: "2026-08-25" }],
  ])("拒绝%s", async (_case, invalidInput) => {
    await expect(createReducerGraph().invoke(invalidInput)).rejects.toThrow();
  });
});
