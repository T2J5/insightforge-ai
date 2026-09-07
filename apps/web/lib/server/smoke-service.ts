import { timingSafeEqual } from "node:crypto";

import {
  evidence,
  reportVersions,
  reports,
  researchRuns,
  users,
  type Database,
} from "@insightforge/db";

import { createSmokeFixture } from "./demo-fixture";

export const isValidSmokeToken = (
  authorization: string | null,
  expectedToken: string | undefined,
): boolean => {
  const expected = expectedToken?.trim();
  if (
    !expected ||
    expected.length < 32 ||
    !authorization?.startsWith("Bearer ")
  ) {
    return false;
  }
  const received = authorization.slice("Bearer ".length);
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
};

/**
 * 生产冒烟任务只写入确定性夹具，不调用模型和搜索供应商，因此不会消耗额度。
 * 每次运行仍创建新的 Run/Evidence/Report，能真实验证数据库写入和公开读取链路。
 */
export const createDeploymentSmokeRun = async (database: Database) => {
  const fixture = createSmokeFixture();
  const ownerId = "system:deployment-smoke";
  const now = new Date();
  await database.transaction(async (transaction) => {
    await transaction
      .insert(users)
      .values({ id: ownerId })
      .onConflictDoNothing({ target: users.id });
    await transaction.insert(researchRuns).values({
      id: fixture.runId,
      ownerId,
      company: fixture.company.company,
      focus: "comprehensive",
      depth: "quick",
      status: "completed",
      tokenUsage: 0,
      estimatedCostCny: "0",
      updatedAt: now,
    });
    await transaction.insert(evidence).values({
      id: fixture.evidenceId,
      runId: fixture.runId,
      ownerId,
      claim: `${fixture.company.company}官网公开了企业使命。`,
      sourceType: "web",
      sourceCategory: "official",
      sourceUrl: fixture.company.sourceUrl,
      sourceTitle: fixture.company.sourceTitle,
      publisher: fixture.company.publisher,
      publishedAt: null,
      retrievedAt: now,
      quote: fixture.company.mission,
      documentId: null,
      page: null,
      confidence: "1",
      contentHash: fixture.contentHash,
    });
    await transaction.insert(reports).values({
      id: fixture.reportId,
      runId: fixture.runId,
      ownerId,
    });
    await transaction.insert(reportVersions).values({
      id: fixture.reportVersionId,
      reportId: fixture.reportId,
      runId: fixture.runId,
      ownerId,
      version: 1,
      content: fixture.content,
      status: "published",
      qualityWarning:
        "部署冒烟夹具：未调用模型或在线搜索，不代表实时企业结论。",
      publishedAt: now,
    });
  });
  return {
    runId: fixture.runId,
    reportId: fixture.reportId,
    status: "completed" as const,
    events: [
      {
        type: "status" as const,
        status: "completed" as const,
        stage: "completed",
        progress: 100,
      },
    ],
  };
};
