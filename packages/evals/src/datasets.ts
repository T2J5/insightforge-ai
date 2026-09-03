import { readFile } from "node:fs/promises";
import { z } from "zod";

export const GoldenDatasetItemSchema = z
  .object({
    id: z.string().regex(/^company-research-v\d+-\d{3}$/),
    company: z.string().trim().min(2).max(120),
    question: z.string().trim().min(5).max(500),
    expectedEvidenceKeys: z.array(z.string().trim().min(1)).min(1),
    expectedFacts: z.array(z.string().trim().min(1)).min(1),
    allowedTools: z.array(z.string().trim().min(1)).min(1),
    forbiddenTools: z.array(z.string().trim().min(1)).default([]),
    maxSteps: z.int().min(1).max(30),
    answerable: z.boolean(),
  })
  .strict();

export const GoldenDatasetSchema = z
  .object({
    name: z.literal("company-research"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    createdAt: z.iso.datetime({ offset: true }),
    items: z.array(GoldenDatasetItemSchema).min(1),
  })
  .strict();

export type GoldenDatasetItem = z.infer<typeof GoldenDatasetItemSchema>;
export type GoldenDataset = z.infer<typeof GoldenDatasetSchema>;

/** JSONL 第一行是元数据，后续每行是一个样本，便于逐条 code review。 */
export const loadGoldenDataset = async (
  path: string,
): Promise<GoldenDataset> => {
  const lines = (await readFile(path, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error("GOLDEN_DATASET_EMPTY");
  const metadata = z
    .object({
      type: z.literal("dataset"),
      name: z.literal("company-research"),
      version: z.string().regex(/^\d+\.\d+\.\d+$/),
      createdAt: z.iso.datetime({ offset: true }),
    })
    .strict()
    .parse(JSON.parse(lines[0]!));
  const items = lines
    .slice(1)
    .map((line) => GoldenDatasetItemSchema.parse(JSON.parse(line)));
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) throw new Error("GOLDEN_DATASET_DUPLICATE_ID");
  return GoldenDatasetSchema.parse({
    name: metadata.name,
    version: metadata.version,
    createdAt: metadata.createdAt,
    items,
  });
};
