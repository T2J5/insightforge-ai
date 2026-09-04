import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadGoldenDataset, type GoldenDatasetItem } from "./datasets";
import { mean, mrr, recallAtK, runSuccessRate, toolAccuracy } from "./metrics";

export type RetrievalVariant = "vector" | "hybrid" | "hybrid-reranked";

export interface EvaluationSystemResult {
  rankedEvidenceKeys: string[];
  usedTools: string[];
  steps: number;
  answered: boolean;
}

export interface EvaluationSystem {
  run(
    item: GoldenDatasetItem,
    variant: RetrievalVariant,
  ): Promise<EvaluationSystemResult>;
}

export interface VariantEvaluation {
  variant: RetrievalVariant;
  recallAt5: number;
  mrr: number;
  toolAccuracy: number;
  runSuccessRate: number;
}

export interface EvaluationReport {
  dataset: { name: string; version: string; sampleCount: number };
  generatedAt: string;
  variants: VariantEvaluation[];
}

const variants: RetrievalVariant[] = ["vector", "hybrid", "hybrid-reranked"];

export const runEvaluation = async (
  datasetPath: string,
  system: EvaluationSystem,
  now = () => new Date(),
): Promise<EvaluationReport> => {
  const dataset = await loadGoldenDataset(datasetPath);
  const reports: VariantEvaluation[] = [];
  for (const variant of variants) {
    const results = await Promise.all(
      dataset.items.map((item) => system.run(item, variant)),
    );
    const relevant = dataset.items.map(
      (item) => new Set(item.expectedEvidenceKeys),
    );
    reports.push({
      variant,
      recallAt5: mean(
        results.map((result, index) =>
          recallAtK(result.rankedEvidenceKeys, relevant[index]!, 5),
        ),
      ),
      mrr: mrr(
        results.map((result) => result.rankedEvidenceKeys),
        relevant,
      ),
      toolAccuracy: mean(
        results.map((result, index) =>
          toolAccuracy({
            usedTools: result.usedTools,
            allowedTools: new Set(dataset.items[index]!.allowedTools),
            forbiddenTools: new Set(dataset.items[index]!.forbiddenTools),
          }),
        ),
      ),
      runSuccessRate: runSuccessRate(
        results.map(
          (result, index) =>
            result.answered === dataset.items[index]!.answerable &&
            result.steps <= dataset.items[index]!.maxSteps,
        ),
      ),
    });
  }
  return {
    dataset: {
      name: dataset.name,
      version: dataset.version,
      sampleCount: dataset.items.length,
    },
    generatedAt: now().toISOString(),
    variants: reports,
  };
};

/** 固定夹具系统：用于 CI 验证评测管线，不调用模型或网络。 */
export const fixtureEvaluationSystem: EvaluationSystem = {
  async run(item, variant) {
    const expected = item.expectedEvidenceKeys;
    const noise = Array.from(
      { length: 5 },
      (_, index) => `noise:${item.id}:${index + 1}`,
    );
    const rankedEvidenceKeys =
      variant === "vector"
        ? [noise[0]!, expected[0]!, ...noise.slice(1), ...expected.slice(1)]
        : variant === "hybrid"
          ? [expected[0]!, noise[0]!, ...expected.slice(1), ...noise.slice(1)]
          : [...expected, ...noise];
    return {
      rankedEvidenceKeys,
      usedTools: [item.allowedTools[0]!],
      steps: Math.min(4, item.maxSteps),
      answered: item.answerable,
    };
  },
};

export const formatEvaluationMarkdown = (report: EvaluationReport): string =>
  [
    `# Evaluation ${report.dataset.name} v${report.dataset.version}`,
    "",
    `Samples: ${report.dataset.sampleCount}`,
    "",
    "| Variant | Recall@5 | MRR | Tool accuracy | Run success |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...report.variants.map(
      (item) =>
        `| ${item.variant} | ${item.recallAt5.toFixed(4)} | ${item.mrr.toFixed(4)} | ${item.toolAccuracy.toFixed(4)} | ${item.runSuccessRate.toFixed(4)} |`,
    ),
    "",
  ].join("\n");

const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const report = await runEvaluation(
    resolve(root, "evals/datasets/company-research.v1.jsonl"),
    fixtureEvaluationSystem,
  );
  const outputDirectory = resolve(root, "evals/results");
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(outputDirectory, "fixtures.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    ),
    writeFile(
      resolve(outputDirectory, "fixtures.md"),
      formatEvaluationMarkdown(report),
    ),
  ]);
  const baseline = report.variants.find(
    (item) => item.variant === "hybrid-reranked",
  );
  if (
    !baseline ||
    baseline.recallAt5 < 0.95 ||
    baseline.mrr < 0.9 ||
    baseline.toolAccuracy < 1 ||
    baseline.runSuccessRate < 1
  ) {
    throw new Error("EVALUATION_BASELINE_REGRESSION");
  }
  console.log(formatEvaluationMarkdown(report));
}
