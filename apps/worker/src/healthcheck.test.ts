import { describe, expect, it, vi } from "vitest";

import { checkWorkerDependencies } from "./healthcheck";

describe("checkWorkerDependencies", () => {
  it("数据库和 Redis 都通过时成功", async () => {
    await expect(
      checkWorkerDependencies({
        checkDatabase: vi.fn().mockResolvedValue(undefined),
        checkRedis: vi.fn().mockResolvedValue("PONG"),
      }),
    ).resolves.toBeUndefined();
  });

  it("任一依赖失败时只抛出稳定公开错误码", async () => {
    await expect(
      checkWorkerDependencies({
        checkDatabase: vi.fn().mockRejectedValue(new Error("secret host")),
        checkRedis: vi.fn().mockResolvedValue("PONG"),
      }),
    ).rejects.toThrow("WORKER_DEPENDENCY_HEALTHCHECK_FAILED");
  });
});
