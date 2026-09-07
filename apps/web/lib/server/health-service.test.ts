import { describe, expect, it, vi } from "vitest";

import { createHealthReport } from "./health-service";

describe("createHealthReport", () => {
  it("仅在数据库和 Redis 都可用时返回 ok", async () => {
    const monotonicNow = vi
      .fn<() => number>()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(14)
      .mockReturnValueOnce(27);
    const report = await createHealthReport({
      checkDatabase: async () => undefined,
      checkRedis: async () => undefined,
      now: () => new Date("2026-09-07T00:00:00.000Z"),
      monotonicNow,
      version: "test-sha",
    });

    expect(report).toMatchObject({
      status: "ok",
      version: "test-sha",
      dependencies: {
        database: { status: "up" },
        redis: { status: "up" },
      },
    });
  });

  it("依赖失败时返回 degraded 且不泄漏异常内容", async () => {
    const report = await createHealthReport({
      checkDatabase: async () => {
        throw new Error("postgresql://secret@private-host/database");
      },
      checkRedis: async () => undefined,
      now: () => new Date("2026-09-07T00:00:00.000Z"),
      monotonicNow: () => 1,
      version: "test-sha",
    });

    expect(report.status).toBe("degraded");
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(report.dependencies.database.status).toBe("down");
  });
});
