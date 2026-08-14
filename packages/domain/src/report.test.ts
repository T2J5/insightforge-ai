import { describe, expect, it } from "vitest";

import { CreateReportVersionSchema, ReportVersionSchema } from "./report";

const versionId = "550e8400-e29b-41d4-a716-446655440000";
const reportId = "550e8400-e29b-41d4-a716-446655440001";
const runId = "550e8400-e29b-41d4-a716-446655440002";
const createdAt = new Date("2026-08-13T08:00:00.000Z");

describe("CreateReportVersionSchema", () => {
  it("接受草稿并为qualityWarning填充null默认值", () => {
    const result = CreateReportVersionSchema.parse({
      reportId,
      runId,
      ownerId: "user-1",
      content: { title: "企业竞争力调研报告", sections: [] },
      status: "draft",
    });

    expect(result.qualityWarning).toBeNull();
    expect(result.status).toBe("draft");
  });

  it("拒绝不可序列化的报告内容", () => {
    expect(
      CreateReportVersionSchema.safeParse({
        reportId,
        runId,
        ownerId: "user-1",
        content: { generatedAt: new Date() },
        status: "draft",
      }).success,
    ).toBe(false);
  });
});

describe("ReportVersionSchema", () => {
  const baseVersion = {
    id: versionId,
    reportId,
    runId,
    ownerId: "user-1",
    version: 1,
    content: { title: "企业竞争力调研报告" },
    qualityWarning: null,
    createdAt,
  };

  it("接受没有publishedAt的草稿", () => {
    expect(
      ReportVersionSchema.parse({
        ...baseVersion,
        status: "draft",
        publishedAt: null,
      }).status,
    ).toBe("draft");
  });

  it("接受包含publishedAt的已发布版本", () => {
    const publishedAt = new Date("2026-08-13T09:00:00.000Z");

    expect(
      ReportVersionSchema.parse({
        ...baseVersion,
        status: "published",
        publishedAt,
      }).publishedAt,
    ).toEqual(publishedAt);
  });

  it.each([
    ["已发布版本缺少发布时间", "published", null],
    ["草稿错误包含发布时间", "draft", new Date()],
  ])("拒绝%s", (_label, status, publishedAt) => {
    expect(
      ReportVersionSchema.safeParse({
        ...baseVersion,
        status,
        publishedAt,
      }).success,
    ).toBe(false);
  });

  it("拒绝非正版本号", () => {
    expect(
      ReportVersionSchema.safeParse({
        ...baseVersion,
        version: 0,
        status: "draft",
        publishedAt: null,
      }).success,
    ).toBe(false);
  });
});
