import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublicReportService: vi.fn(),
  getPublished: vi.fn(),
}));

vi.mock("@/lib/server/report-service-provider", () => ({
  getPublicReportService: mocks.getPublicReportService,
}));

import {
  PublishedReportNotFoundError,
  ReportNotPublicError,
} from "@/lib/server/report-service";
import { GET } from "./route";

const REPORT_ID = "550e8400-e29b-41d4-a716-446655440000";
const context = (reportId = REPORT_ID) => ({
  params: Promise.resolve({ reportId }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPublicReportService.mockReturnValue({
    getPublished: mocks.getPublished,
  });
  mocks.getPublished.mockResolvedValue({ reportId: REPORT_ID });
});

describe("GET /api/reports/[reportId]", () => {
  it("非法 UUID 返回 400 且不访问服务", async () => {
    const response = await GET(new Request("http://localhost"), context("bad"));
    expect(response.status).toBe(400);
    expect(mocks.getPublicReportService).not.toHaveBeenCalled();
  });

  it("返回公开报告并设置短时共享缓存", async () => {
    const response = await GET(new Request("http://localhost"), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=300");
    await expect(response.json()).resolves.toEqual({ reportId: REPORT_ID });
  });

  it("未发布报告返回 404", async () => {
    mocks.getPublished.mockRejectedValueOnce(
      new PublishedReportNotFoundError(),
    );
    const response = await GET(new Request("http://localhost"), context());
    expect(response.status).toBe(404);
  });

  it("包含私有文档引用的报告返回 403", async () => {
    mocks.getPublished.mockRejectedValueOnce(new ReportNotPublicError());
    const response = await GET(new Request("http://localhost"), context());
    expect(response.status).toBe(403);
  });

  it("内部错误返回脱敏 500", async () => {
    mocks.getPublished.mockRejectedValueOnce(new Error("secret db url"));
    const response = await GET(new Request("http://localhost"), context());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
