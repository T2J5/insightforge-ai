import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CreateReportVersionSchema,
  type CreateReportVersion,
} from "@insightforge/domain";
import { config } from "dotenv";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../client";
import { reports, reportVersions, users } from "../schema";
import { ReportRepository } from "./report-repository";
import { RunRepository } from "./run-repository";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));

config({
  path: resolve(currentDirectory, "../../../../.env"),
});

const databaseTestUrl = process.env.DATABASE_TEST_URL;

if (!databaseTestUrl) {
  throw new Error("DATABASE_TEST_URL environment variable is not defined");
}

/**
 * 并发版本测试至少需要两个数据库连接。
 *
 * 如果只有一个连接，两个事务会在客户端被串行执行，
 * 即使没有正确使用数据库锁，并发测试也可能错误通过。
 */
const connection = createDatabase(databaseTestUrl, {
  maxConnections: 4,
});

const reportRepository = new ReportRepository(connection.db);

const runRepository = new RunRepository(connection.db);

const testOwnerId = "report-repository-test-user";

const testOwnerEmail = "report-repository-test@example.com";

/**
 * 创建属于 ReportRepository 测试用户的调研任务。
 */
const createTestRun = () => {
  return runRepository.create({
    ownerId: testOwnerId,
    company: "ByteDance",
    focus: "business",
    depth: "deep",
  });
};

/**
 * 构造合法的报告版本创建参数。
 */
const createReportInput = (
  reportId: string,
  runId: string,
  overrides: Partial<CreateReportVersion> = {},
): CreateReportVersion => {
  return CreateReportVersionSchema.parse({
    reportId,
    runId,
    ownerId: testOwnerId,
    content: {
      title: "ByteDance Research Report",
      summary: "Initial report draft",
      sections: [],
    },
    status: "draft",
    qualityWarning: null,
    ...overrides,
  });
};

describe.sequential("ReportRepository", () => {
  /**
   * 每个测试只清理自己的固定测试用户。
   *
   * users → research_runs → reports/report_versions
   * 会通过 ON DELETE CASCADE 自动清理。
   */
  beforeEach(async () => {
    await connection.db.delete(users).where(eq(users.id, testOwnerId));

    await connection.db.insert(users).values({
      id: testOwnerId,
      email: testOwnerEmail,
      name: "Report Repository Test",
    });
  });

  afterAll(async () => {
    await connection.db.delete(users).where(eq(users.id, testOwnerId));

    await connection.close();
  });

  it("creates the report and its first draft version", async () => {
    const run = await createTestRun();

    const reportId = randomUUID();

    const version = await reportRepository.createVersion(
      createReportInput(reportId, run.id),
    );

    expect(version).toMatchObject({
      reportId,
      runId: run.id,
      ownerId: testOwnerId,
      version: 1,
      status: "draft",
      qualityWarning: null,
      publishedAt: null,
      createdAt: expect.any(Date),
    });

    expect(version.id).toEqual(expect.any(String));

    const storedReports = await connection.db
      .select()
      .from(reports)
      .where(eq(reports.id, reportId));

    expect(storedReports).toHaveLength(1);

    expect(storedReports[0]).toMatchObject({
      id: reportId,
      runId: run.id,
      ownerId: testOwnerId,
    });
  });

  it("creates immutable incrementing versions", async () => {
    const run = await createTestRun();

    const reportId = randomUUID();

    const first = await reportRepository.createVersion(
      createReportInput(reportId, run.id, {
        content: {
          title: "Version One",
          sections: [],
        },
      }),
    );

    const second = await reportRepository.createVersion(
      createReportInput(reportId, run.id, {
        content: {
          title: "Version Two",
          sections: [],
        },
      }),
    );

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.id).not.toBe(first.id);

    const storedVersions = await connection.db
      .select()
      .from(reportVersions)
      .where(eq(reportVersions.reportId, reportId))
      .orderBy(asc(reportVersions.version));

    expect(storedVersions).toHaveLength(2);

    expect(storedVersions[0]?.content).toEqual({
      title: "Version One",
      sections: [],
    });

    expect(storedVersions[1]?.content).toEqual({
      title: "Version Two",
      sections: [],
    });
  });

  it("allocates unique versions for concurrent requests", async () => {
    const run = await createTestRun();

    const reportId = randomUUID();

    const [first, second] = await Promise.all([
      reportRepository.createVersion(
        createReportInput(reportId, run.id, {
          content: {
            title: "Concurrent Version A",
          },
        }),
      ),
      reportRepository.createVersion(
        createReportInput(reportId, run.id, {
          content: {
            title: "Concurrent Version B",
          },
        }),
      ),
    ]);

    const allocatedVersions = [first.version, second.version].sort(
      (left, right) => left - right,
    );

    expect(allocatedVersions).toEqual([1, 2]);

    const storedVersions = await connection.db
      .select()
      .from(reportVersions)
      .where(eq(reportVersions.reportId, reportId));

    expect(storedVersions).toHaveLength(2);
  });

  it("does not expose a draft as published", async () => {
    const run = await createTestRun();

    const reportId = randomUUID();

    await reportRepository.createVersion(
      createReportInput(reportId, run.id, {
        status: "draft",
      }),
    );

    const published = await reportRepository.getPublished(reportId);

    expect(published).toBeNull();
  });

  it("returns the latest published version and hides newer drafts", async () => {
    const run = await createTestRun();

    const reportId = randomUUID();

    const firstPublished = await reportRepository.createVersion(
      createReportInput(reportId, run.id, {
        status: "published",
        content: {
          title: "First Published Report",
        },
      }),
    );

    const secondPublished = await reportRepository.createVersion(
      createReportInput(reportId, run.id, {
        status: "published",
        content: {
          title: "Second Published Report",
        },
      }),
    );

    await reportRepository.createVersion(
      createReportInput(reportId, run.id, {
        status: "draft",
        content: {
          title: "Unpublished New Draft",
        },
      }),
    );

    expect(firstPublished.publishedAt).toBeInstanceOf(Date);

    expect(secondPublished.publishedAt).toBeInstanceOf(Date);

    const published = await reportRepository.getPublished(reportId);

    expect(published).not.toBeNull();

    expect(published).toMatchObject({
      id: secondPublished.id,
      reportId,
      version: 2,
      status: "published",
      content: {
        title: "Second Published Report",
      },
    });
  });

  it("rejects changing the run identity of an existing report", async () => {
    const firstRun = await createTestRun();

    const secondRun = await createTestRun();

    const reportId = randomUUID();

    await reportRepository.createVersion(
      createReportInput(reportId, firstRun.id),
    );

    await expect(
      reportRepository.createVersion(createReportInput(reportId, secondRun.id)),
    ).rejects.toThrow("REPORT_IDENTITY_CONFLICT");

    const storedVersions = await connection.db
      .select()
      .from(reportVersions)
      .where(eq(reportVersions.reportId, reportId));

    expect(storedVersions).toHaveLength(1);
  });

  it("returns null when a report does not exist", async () => {
    const published = await reportRepository.getPublished(
      "00000000-0000-4000-8000-000000000000",
    );

    expect(published).toBeNull();
  });
  it("rejects a different report id for the same run", async () => {
    const run = await createTestRun();

    const originalReportId = randomUUID();

    const conflictingReportId = randomUUID();

    await reportRepository.createVersion(
      createReportInput(originalReportId, run.id),
    );

    await expect(
      reportRepository.createVersion(
        createReportInput(conflictingReportId, run.id),
      ),
    ).rejects.toThrow("REPORT_IDENTITY_CONFLICT");

    /**
     * 冲突调用不能创建第二个 reports 主记录。
     */
    const storedReports = await connection.db
      .select()
      .from(reports)
      .where(eq(reports.runId, run.id));

    expect(storedReports).toHaveLength(1);

    expect(storedReports[0]?.id).toBe(originalReportId);

    /**
     * 冲突事务已经回滚，
     * 不能产生额外报告版本。
     */
    const storedVersions = await connection.db
      .select()
      .from(reportVersions)
      .where(eq(reportVersions.reportId, originalReportId));

    expect(storedVersions).toHaveLength(1);
  });
});
