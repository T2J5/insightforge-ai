import type { ResearchRun } from "@insightforge/domain";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestIdentity: vi.fn(),
  getRunService: vi.fn(),
  createRun: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({
  resolveRequestIdentity: mocks.resolveRequestIdentity,
}));

vi.mock("@/lib/server/run-service-provider", () => ({
  getRunService: mocks.getRunService,
}));

import { RunDispatchError, RunGovernanceError } from "@/lib/server/run-service";

import { POST } from "./route";

const runId = "550e8400-e29b-41d4-a716-446655440000";

const queuedRun: ResearchRun = {
  id: runId,
  ownerId: "anonymous:owner-1",
  company: "OpenAI",
  focus: "technology",
  depth: "quick",
  status: "queued",
  tokenUsage: 0,
  estimatedCostCny: 0,
  createdAt: new Date("2026-08-18T00:00:00.000Z"),
  updatedAt: new Date("2026-08-18T00:00:00.000Z"),
};

const createRequest = (body: string): NextRequest =>
  new NextRequest("http://localhost/api/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body,
  });

const validBody = JSON.stringify({
  company: " OpenAI ",
  focus: "technology",
  depth: "quick",
});

beforeEach(() => {
  mocks.resolveRequestIdentity.mockReset().mockReturnValue({
    ownerId: "anonymous:owner-1",
  });
  mocks.createRun.mockReset().mockResolvedValue(queuedRun);
  mocks.getRunService.mockReset().mockReturnValue({
    createRun: mocks.createRun,
  });
});

describe("POST /api/runs", () => {
  it("非法JSON返回稳定的400响应且不初始化服务", async () => {
    const response = await POST(createRequest("{"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_JSON",
      message: "请求体不是有效的 JSON。",
      issues: [],
    });
    expect(mocks.resolveRequestIdentity).not.toHaveBeenCalled();
    expect(mocks.getRunService).not.toHaveBeenCalled();
  });

  it("参数无效时返回字段路径和Zod错误码", async () => {
    const response = await POST(
      createRequest(
        JSON.stringify({
          company: "A",
          focus: "unknown",
          depth: "quick",
        }),
      ),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "INVALID_REQUEST",
      message: "创建调研任务的参数无效",
    });
    expect(body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "company", code: "too_small" }),
        expect.objectContaining({ path: "focus", code: "invalid_value" }),
      ]),
    );
    expect(mocks.resolveRequestIdentity).not.toHaveBeenCalled();
    expect(mocks.getRunService).not.toHaveBeenCalled();
  });

  it("拒绝请求体提供ownerId", async () => {
    const response = await POST(
      createRequest(
        JSON.stringify({
          company: "OpenAI",
          focus: "technology",
          depth: "quick",
          ownerId: "another-user",
        }),
      ),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("INVALID_REQUEST");
    expect(body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unrecognized_keys" }),
      ]),
    );
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it("使用服务端身份创建任务并返回202", async () => {
    const request = createRequest(validBody);

    const response = await POST(request);

    expect(mocks.resolveRequestIdentity).toHaveBeenCalledWith(request);
    expect(mocks.createRun).toHaveBeenCalledWith("anonymous:owner-1", {
      company: "OpenAI",
      focus: "technology",
      depth: "quick",
      documentIds: [],
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      runId,
      status: "queued",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("首次匿名请求把签名身份Cookie写入响应", async () => {
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

    const response = await POST(createRequest(validBody));
    const cookie = response.headers.get("set-cookie");

    expect(response.status).toBe(202);
    expect(cookie).toContain(
      "insightforge_anonymous_session=anonymous-id.signature",
    );
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=2592000");
  });

  it("入队失败返回503和公开错误码", async () => {
    mocks.createRun.mockRejectedValueOnce(
      new RunDispatchError(new Error("redis connection refused")),
    );

    const response = await POST(createRequest(validBody));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "RUN_DISPATCH_FAILED",
      message: "调研任务暂时无法加入执行队列",
      issues: [],
    });
  });

  it("额度耗尽时返回429和限额响应头", async () => {
    mocks.createRun.mockRejectedValueOnce(
      new RunGovernanceError("RUN_RATE_LIMITED", {
        limit: 1,
        remaining: 0,
        resetAt: new Date("2026-09-05T00:00:00.000Z"),
      }),
    );
    const response = await POST(createRequest(validBody));
    expect(response.status).toBe(429);
    expect(response.headers.get("x-ratelimit-limit")).toBe("1");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
    await expect(response.json()).resolves.toMatchObject({
      code: "RUN_RATE_LIMITED",
    });
  });

  it("未知内部错误返回脱敏的500响应", async () => {
    mocks.createRun.mockRejectedValueOnce(
      new Error("postgresql://admin:secret@database.internal/research"),
    );

    const response = await POST(createRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      code: "INTERNAL_ERROR",
      message: "服务器暂时无法创建调研任务",
      issues: [],
    });
    expect(JSON.stringify(body)).not.toContain("admin:secret");
    expect(JSON.stringify(body)).not.toContain("database.internal");
  });
});
