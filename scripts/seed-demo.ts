import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

import {
  createDatabase,
  evidence,
  reportVersions,
  reports,
  researchRuns,
  users,
} from "../packages/db/src/index";

import {
  createDemoReportContent,
  DEMO_COMPANIES,
} from "../apps/web/lib/server/demo-fixture";

const localEnvironment = path.resolve(".env");
if (existsSync(localEnvironment)) loadEnvFile(localEnvironment);

const requireDatabaseUrl = (): string => {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL_REQUIRED");
  return value;
};

const idFor = (group: "run" | "evidence" | "version", index: number) => {
  const suffix =
    group === "run"
      ? index + 1
      : group === "evidence"
        ? index + 101
        : index + 201;
  return `10000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
};

export const seedDemoReports = async (
  databaseUrl: string,
): Promise<string[]> => {
  const connection = createDatabase(databaseUrl, { maxConnections: 2 });
  const ownerId = "demo:public";
  const now = new Date();
  const reportIds: string[] = [];
  try {
    await connection.db
      .insert(users)
      .values({ id: ownerId, name: "InsightForge Demo" })
      .onConflictDoNothing({ target: users.id });

    for (const [index, company] of DEMO_COMPANIES.entries()) {
      const runId = idFor("run", index);
      const evidenceId = idFor("evidence", index);
      const versionId = idFor("version", index);
      const contentHash = createHash("sha256")
        .update(`${company.sourceUrl}\n${company.mission}`)
        .digest("hex");
      await connection.db.transaction(async (transaction) => {
        await transaction
          .insert(researchRuns)
          .values({
            id: runId,
            ownerId,
            company: company.company,
            focus: "comprehensive",
            depth: "quick",
            status: "completed",
            tokenUsage: 0,
            estimatedCostCny: "0",
            updatedAt: now,
          })
          .onConflictDoNothing({ target: researchRuns.id });
        await transaction
          .insert(evidence)
          .values({
            id: evidenceId,
            runId,
            ownerId,
            claim: `${company.company}官网公开了企业使命。`,
            sourceType: "web",
            sourceCategory: "official",
            sourceUrl: company.sourceUrl,
            sourceTitle: company.sourceTitle,
            publisher: company.publisher,
            publishedAt: null,
            retrievedAt: now,
            quote: company.mission,
            documentId: null,
            page: null,
            confidence: "1",
            contentHash,
          })
          .onConflictDoNothing({ target: evidence.id });
        await transaction
          .insert(reports)
          .values({ id: runId, runId, ownerId })
          .onConflictDoNothing({ target: reports.id });
        await transaction
          .insert(reportVersions)
          .values({
            id: versionId,
            reportId: runId,
            runId,
            ownerId,
            version: 1,
            content: createDemoReportContent(company.company, evidenceId),
            status: "published",
            qualityWarning:
              "预置演示报告：仅用于展示报告与证据链交互，不代表实时企业调研结论。",
            publishedAt: now,
          })
          .onConflictDoNothing({ target: reportVersions.id });
      });
      reportIds.push(runId);
    }
    return reportIds;
  } finally {
    await connection.close();
  }
};

const reportIds = await seedDemoReports(requireDatabaseUrl());
console.log(`Seeded ${reportIds.length} public demo reports.`);
