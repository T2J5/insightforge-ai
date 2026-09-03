import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { fixtureEvaluationSystem, runEvaluation } from "./run-evals";

describe("runEvaluation", () => {
  it("compares all deterministic retrieval variants without network access", async () => {
    const report = await runEvaluation(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../evals/datasets/company-research.v1.jsonl",
      ),
      fixtureEvaluationSystem,
      () => new Date("2026-09-03T00:00:00.000Z"),
    );
    expect(report.dataset.sampleCount).toBeGreaterThanOrEqual(50);
    expect(report.variants.map((item) => item.variant)).toEqual([
      "vector",
      "hybrid",
      "hybrid-reranked",
    ]);
    expect(report.variants[2]!.mrr).toBe(1);
  });
});
