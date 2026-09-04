import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GoldenDatasetItem } from "./datasets";
import {
  formatEvaluationMarkdown,
  runEvaluation,
  type EvaluationSystem,
  type RetrievalVariant,
} from "./run-evals";

const requireEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
};

/** 调用部署环境的受保护入口，Secret 不进入数据集和报告。 */
class HttpEvaluationSystem implements EvaluationSystem {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
  ) {}

  async run(item: GoldenDatasetItem, variant: RetrievalVariant) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ item, variant }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`ONLINE_EVAL_HTTP_${response.status}`);
    return response.json() as Promise<{
      rankedEvidenceKeys: string[];
      usedTools: string[];
      steps: number;
      answered: boolean;
    }>;
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const report = await runEvaluation(
  resolve(root, "evals/datasets/company-research.v1.jsonl"),
  new HttpEvaluationSystem(
    requireEnvironment("ONLINE_EVAL_ENDPOINT"),
    requireEnvironment("ONLINE_EVAL_TOKEN"),
  ),
);
const outputDirectory = resolve(root, "evals/results");
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(
    resolve(outputDirectory, "online.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  ),
  writeFile(
    resolve(outputDirectory, "online.md"),
    formatEvaluationMarkdown(report),
  ),
]);
