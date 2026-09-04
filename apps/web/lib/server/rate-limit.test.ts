import { describe, expect, it, vi } from "vitest";

import { guestQuickPolicy, RedisRateLimiter } from "./rate-limit";

describe("RedisRateLimiter", () => {
  it("uses one atomic script and reports daily guest quota", async () => {
    const redis = { eval: vi.fn().mockResolvedValue([1, 86_400]) };
    const limiter = new RedisRateLimiter(
      redis,
      () => new Date("2026-09-04T00:00:00.000Z"),
    );
    await expect(limiter.consume("ip:hash", guestQuickPolicy)).resolves.toEqual(
      {
        allowed: true,
        limit: 1,
        remaining: 0,
        resetAt: new Date("2026-09-05T00:00:00.000Z"),
      },
    );
    expect(redis.eval).toHaveBeenCalledOnce();
    expect(redis.eval.mock.calls[0]![0]).toContain("INCR");
    expect(redis.eval.mock.calls[0]![0]).toContain("EXPIRE");
  });

  it("rejects the second guest request without exposing the raw subject", async () => {
    const redis = { eval: vi.fn().mockResolvedValue([2, 100]) };
    const result = await new RedisRateLimiter(redis).consume(
      "anonymous:sensitive-id",
      guestQuickPolicy,
    );
    expect(result.allowed).toBe(false);
    expect(redis.eval.mock.calls[0]![2]).not.toContain("sensitive-id");
  });
});
