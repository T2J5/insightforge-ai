import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { loadGoldenDataset } from "./datasets";

describe("loadGoldenDataset", () => {
  it("loads versioned JSONL and rejects duplicate sample ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "insightforge-evals-"));
    const path = join(directory, "dataset.jsonl");
    const metadata = {
      type: "dataset",
      name: "company-research",
      version: "1.0.0",
      createdAt: "2026-09-03T00:00:00.000Z",
    };
    const item = {
      id: "company-research-v1-001",
      company: "小米集团",
      question: "公司的核心业务是什么？",
      expectedEvidenceKeys: ["annual-report"],
      expectedFacts: ["存在智能手机业务"],
      allowedTools: ["search_web"],
      forbiddenTools: [],
      maxSteps: 5,
      answerable: true,
    };
    await writeFile(
      path,
      `${JSON.stringify(metadata)}\n${JSON.stringify(item)}\n${JSON.stringify(item)}\n`,
    );
    await expect(loadGoldenDataset(path)).rejects.toThrow(
      "GOLDEN_DATASET_DUPLICATE_ID",
    );
  });
});
