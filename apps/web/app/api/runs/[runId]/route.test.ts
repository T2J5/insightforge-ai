import type { ResearchRun } from "@insightforge/domain";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestIdentity: vi.fn(),
  getRunService: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({
  resolveRequestIdentity: mocks.resolveRequestIdentity,
}));

vi.mock("@/lib/server/run-service-provider", () => ({
  getRunService: mocks.getRunService,
}));

import { RunQueryError } from "@/lib/server/run-service";

import { GET } from "./route";

const runId = "550e8400-e29b-41d4-a716-446655440000";

const run: ResearchRun = {
  id: runId,
  ownerId: "anonymous:owner-1",
  company: "OpenAI",
  focus: "technology",
  depth: "quick",
  status: "running",
  tokenUsage: 12_450,
  estimatedCostCny: 0.83,
  createdAt: new Date("2026-08-18T08:00:00.000Z"),
  updatedAt: new Date("2026-08-18T08:01:30.000Z"),
};

const request = (): NextRequest =>
  new NextRequest(`http://localhost/api/runs/${runId}`);

const context = (value: string = runId) => ({
  params: Promise.resolve({ runId: value }),
});

beforeEach(() => {
  mocks.resolveRequestIdentity.mockReset().mockReturnValue({
    ownerId: "anonymous:owner-1",
  });
  mocks.getRun.mockReset().mockResolvedValue(run);
  mocks.getRunService.mockReset().mockReturnValue({
    getRun: mocks.getRun,
  });
});

describe("GET /api/runs/[runId]", () => {
  it("非法runId返回400且不访问身份和数据库", async () => {
    const response = await GET(request(), context("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_RUN_ID",
      message: "调研任务ID格式无效",
      issues: [],
    });
    expect(mocks.resolveRequestIdentity).not.toHaveBeenCalled();
    expect(mocks.getRunService).not.toHaveBeenCalled();
  });

  it("返回当前用户的任务且不泄露ownerId", async () => {
    const nextRequest = request();
    const response = await GET(nextRequest, context());
    const body = await response.json();

    expect(mocks.resolveRequestIdentity).toHaveBeenCalledWith(nextRequest);
    expect(mocks.getRun).toHaveBeenCalledWith("anonymous:owner-1", runId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toEqual({
      runId,
      company: "OpenAI",
      focus: "technology",
      depth: "quick",
      status: "running",
      tokenUsage: 12_450,
      estimatedCostCny: 0.83,
      createdAt: "2026-08-18T08:00:00.000Z",
      updatedAt: "2026-08-18T08:01:30.000Z",
    });
    expect(body).not.toHaveProperty("ownerId");
  });

  it("首次匿名请求把身份Cookie写入成功响应", async () => {
    mocks.resolveRequestIdentity.mockReturnValue({
      ownerId: "anonymous:owner-1",
      cookie: {
        name: "insightforge_anonymous_session",
        value: "anonymous-id.signature",
        options: {
          httpOnly: true,
          secure: false,
          sameSite: "lax",
          path: "/",
          maxAge: 2_592_000,
        },
      },
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "insightforge_anonymous_session=anonymous-id.signature",
    );
  });

  it("任务不存在或不属于当前用户时返回相同404", async () => {
    mocks.getRun.mockRejectedValueOnce(new RunQueryError());

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "RUN_NOT_FOUND",
      message: "调研任务不存在",
      issues: [],
    });
  });

  it("身份配置异常返回脱敏的500响应", async () => {
    mocks.resolveRequestIdentity.mockImplementationOnce(() => {
      throw new Error("AUTH_SECRET_REQUIRED");
    });

    const response = await GET(request(), context());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      code: "INTERNAL_ERROR",
      message: "服务器暂时无法验证用户身份",
      issues: [],
    });
    expect(JSON.stringify(body)).not.toContain("AUTH_SECRET");
    expect(mocks.getRunService).not.toHaveBeenCalled();
  });

  it("数据库异常返回脱敏的500响应", async () => {
    mocks.getRun.mockRejectedValueOnce(
      new Error("postgresql://admin:secret@database.internal/research"),
    );

    const response = await GET(request(), context());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      code: "INTERNAL_ERROR",
      message: "服务器暂时无法查询调研任务",
      issues: [],
    });
    expect(JSON.stringify(body)).not.toContain("admin:secret");
  });
});
