import type { ResearchRun } from "@insightforge/domain";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestIdentity: vi.fn(),
  getRunService: vi.fn(),
  getRun: vi.fn(),
  getRunEventReader: vi.fn(),
  createRunEventSubscriber: vi.fn(),
  createRunEventStream: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({
  resolveRequestIdentity: mocks.resolveRequestIdentity,
}));

vi.mock("@/lib/server/run-service-provider", () => ({
  getRunService: mocks.getRunService,
}));

vi.mock("@/lib/server/run-event-stream-provider", () => ({
  getRunEventReader: mocks.getRunEventReader,
  createRunEventSubscriber: mocks.createRunEventSubscriber,
}));

vi.mock("@/lib/server/run-event-stream", () => ({
  createRunEventStream: mocks.createRunEventStream,
}));

import { RunQueryError } from "@/lib/server/run-service";
import { GET } from "./route";

const runId = "550e8400-e29b-41d4-a716-446655440000";
const eventReader = { lrange: vi.fn() };
const eventSubscriber = { subscribe: vi.fn() };

const run: ResearchRun = {
  id: runId,
  ownerId: "anonymous:owner-1",
  company: "OpenAI",
  focus: "technology",
  depth: "quick",
  status: "running",
  tokenUsage: 0,
  estimatedCostCny: 0,
  createdAt: new Date("2026-08-24T08:00:00.000Z"),
  updatedAt: new Date("2026-08-24T08:01:00.000Z"),
};

const request = (lastEventId?: string, id: string = runId): NextRequest => {
  const headers = new Headers();
  if (lastEventId !== undefined) headers.set("Last-Event-ID", lastEventId);
  return new NextRequest(`http://localhost/api/runs/${id}/events`, { headers });
};

const context = (id: string = runId) => ({
  params: Promise.resolve({ runId: id }),
});

beforeEach(() => {
  mocks.resolveRequestIdentity.mockReset().mockReturnValue({
    ownerId: "anonymous:owner-1",
  });
  mocks.getRun.mockReset().mockResolvedValue(run);
  mocks.getRunService.mockReset().mockReturnValue({ getRun: mocks.getRun });
  mocks.getRunEventReader.mockReset().mockReturnValue(eventReader);
  mocks.createRunEventSubscriber.mockReset().mockReturnValue(eventSubscriber);
  mocks.createRunEventStream
    .mockReset()
    .mockReturnValue(new ReadableStream<Uint8Array>());
});

describe("GET /api/runs/[runId]/events", () => {
  it("非法 runId 返回 400，且不访问身份、数据库和 Redis", async () => {
    const response = await GET(
      request(undefined, "not-a-uuid"),
      context("not-a-uuid"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_RUN_ID",
      message: "调研任务ID格式无效",
      issues: [],
    });
    expect(mocks.resolveRequestIdentity).not.toHaveBeenCalled();
    expect(mocks.getRunService).not.toHaveBeenCalled();
    expect(mocks.createRunEventSubscriber).not.toHaveBeenCalled();
  });

  it.each(["-1", "1.5", "abc"])(
    "拒绝非法 Last-Event-ID：%s",
    async (lastEventId) => {
      const response = await GET(request(lastEventId), context());

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "INVALID_LAST_EVENT_ID",
      });
      expect(mocks.getRunService).not.toHaveBeenCalled();
    },
  );

  it("先验证任务所有权，再创建 Redis 订阅连接", async () => {
    mocks.getRun.mockRejectedValueOnce(new RunQueryError());

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "RUN_NOT_FOUND",
    });
    expect(mocks.getRun).toHaveBeenCalledWith("anonymous:owner-1", runId);
    expect(mocks.createRunEventSubscriber).not.toHaveBeenCalled();
  });

  it("返回 SSE 响应并把 Last-Event-ID、状态和连接传给事件流", async () => {
    const nextRequest = request("12");

    const response = await GET(nextRequest, context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(mocks.createRunEventStream).toHaveBeenCalledWith({
      runId,
      currentStatus: "running",
      lastEventId: 12,
      reader: eventReader,
      subscriber: eventSubscriber,
      signal: nextRequest.signal,
    });
  });

  it("没有 Last-Event-ID 时从事件 0 开始回放", async () => {
    await GET(request(), context());

    expect(mocks.createRunEventStream).toHaveBeenCalledWith(
      expect.objectContaining({ lastEventId: 0 }),
    );
  });

  it("首次匿名访问会在 SSE 响应中写入身份 Cookie", async () => {
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

    expect(response.headers.get("set-cookie")).toContain(
      "insightforge_anonymous_session=anonymous-id.signature",
    );
  });

  it("Redis 初始化失败时返回脱敏的 503", async () => {
    mocks.createRunEventSubscriber.mockImplementationOnce(() => {
      throw new Error("redis://default:secret@redis.internal:6379");
    });

    const response = await GET(request(), context());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      code: "RUN_EVENTS_UNAVAILABLE",
      message: "调研进度服务暂时不可用",
      issues: [],
    });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("redis.internal");
  });
});
