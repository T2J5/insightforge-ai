import { describe, expect, it } from "vitest";

import {
  citationCoverage,
  mrr,
  percentile,
  recallAtK,
  reciprocalRank,
  runSuccessRate,
  toolAccuracy,
} from "./metrics";

describe("retrieval metrics", () => {
  it("uses hand-calculated Recall@K", () => {
    expect(recallAtK(["a", "x", "b"], new Set(["a", "b"]), 2)).toBe(0.5);
    expect(recallAtK(["a"], new Set<string>(), 5)).toBe(1);
  });

  it("uses the first relevant result for reciprocal rank and averages queries", () => {
    expect(reciprocalRank(["x", "target", "y"], new Set(["target"]))).toBe(0.5);
    expect(mrr([["x", "a"], ["b"]], [new Set(["a"]), new Set(["b"])])).toBe(
      0.75,
    );
  });
});

describe("agent quality metrics", () => {
  it("counts only fact blocks in citation coverage", () => {
    expect(
      citationCoverage(
        [
          { kind: "fact", citationIds: ["valid"] },
          { kind: "fact", citationIds: [] },
          { kind: "inference", citationIds: [] },
        ],
        new Set(["valid"]),
      ),
    ).toBe(0.5);
  });

  it("penalizes disallowed and forbidden tool calls", () => {
    expect(
      toolAccuracy({
        usedTools: ["search_web", "shell", "search_documents"],
        allowedTools: new Set(["search_web", "search_documents"]),
        forbiddenTools: new Set(["shell"]),
      }),
    ).toBeCloseTo(2 / 3);
  });

  it("computes successful run ratio", () => {
    expect(runSuccessRate([true, false, true, true])).toBe(0.75);
    expect(runSuccessRate([])).toBe(0);
  });

  it("computes nearest-rank percentiles", () => {
    expect(percentile([10, 40, 20, 30], 0.95)).toBe(40);
    expect(percentile([], 0.95)).toBe(0);
    expect(() => percentile([1], 1.1)).toThrow("METRIC_QUANTILE_INVALID");
  });
});
