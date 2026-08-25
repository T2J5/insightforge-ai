import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestIdentity: vi.fn(),
  getRunService: vi.fn(),
  cancelRun: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({
  resolveRequestIdentity: mocks.resolveRequestIdentity,
}));

vi.mock("@/lib/server/run-service-provider", () => ({
  getRunService: mocks.getRunService,
}));

import { RunCancellationError } from "@/lib/server/run-service";

import { POST } from "./route";

const runId = "550e8400-e29b-41d4-a716-446655440000";

const request = (): NextRequest =>
  new NextRequest(`http://localhost/api/runs/${runId}/cancel`, {
    method: "POST",
  });

const context = (value: string = runId) => ({
  params: Promise.resolve({ runId: value }),
});

beforeEach(() => {
  mocks.resolveRequestIdentity.mockReset().mockReturnValue({
    ownerId: "anonymous:owner-1",
  });
  mocks.cancelRun.mockReset().mockResolvedValue(undefined);
  mocks.getRunService.mockReset().mockReturnValue({
    cancelRun: mocks.cancelRun,
  });
});

describe("POST /api/runs/[runId]/cancel", () => {
  it("非法runId返回400且不访问身份或服务", async () => {
    const response = await POST(request(), context("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_RUN_ID",
      message: "调研任务ID格式无效",
      issues: [],
    });
    expect(mocks.resolveRequestIdentity).not.toHaveBeenCalled();
    expect(mocks.getRunService).not.toHaveBeenCalled();
  });

  it("取消当前用户任务并返回202", async () => {
    const nextRequest = request();

    const response = await POST(nextRequest, context());

    expect(mocks.resolveRequestIdentity).toHaveBeenCalledWith(nextRequest);
    expect(mocks.cancelRun).toHaveBeenCalledWith("anonymous:owner-1", runId);
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      runId,
      status: "cancelled",
    });
  });

  it("首次匿名请求把身份Cookie写入响应", async () => {
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

    const response = await POST(request(), context());

    expect(response.headers.get("set-cookie")).toContain(
      "insightforge_anonymous_session=anonymous-id.signature",
    );
  });

  it("任务不存在或越权时返回404", async () => {
    mocks.cancelRun.mockRejectedValueOnce(
      new RunCancellationError("RUN_NOT_FOUND"),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "RUN_NOT_FOUND",
      issues: [],
    });
  });

  it("任务状态不允许取消时返回409冲突", async () => {
    mocks.cancelRun.mockRejectedValueOnce(
      new RunCancellationError("RUN_NOT_CANCELLABLE"),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "RUN_NOT_CANCELLABLE",
      issues: [],
    });
  });

  it("Redis取消通知失败时返回可重试的503", async () => {
    mocks.cancelRun.mockRejectedValueOnce(
      new RunCancellationError(
        "RUN_CANCELLATION_SIGNAL_FAILED",
        new Error("redis unavailable"),
      ),
    );

    const response = await POST(request(), context());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      code: "RUN_CANCELLATION_SIGNAL_FAILED",
      issues: [],
    });
    expect(JSON.stringify(body)).not.toContain("redis unavailable");
  });

  it("身份配置异常返回脱敏的500", async () => {
    mocks.resolveRequestIdentity.mockImplementationOnce(() => {
      throw new Error("AUTH_SECRET_REQUIRED");
    });

    const response = await POST(request(), context());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("AUTH_SECRET");
    expect(mocks.getRunService).not.toHaveBeenCalled();
  });

  it("未知错误返回脱敏的500", async () => {
    mocks.cancelRun.mockRejectedValueOnce(
      new Error("postgresql://admin:secret@database.internal/research"),
    );

    const response = await POST(request(), context());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("admin:secret");
  });
});
