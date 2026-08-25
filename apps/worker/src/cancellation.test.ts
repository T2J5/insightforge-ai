import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import { CancellationGuard, type CancellationReader } from "./cancellation";

const runId = "550e8400-e29b-41d4-a716-446655440000";

const createReader = (value: string | null): CancellationReader => ({
  get: vi.fn().mockResolvedValue(value),
});

describe("CancellationGuard.isCancelled", () => {
  it("使用约定的Redis键查询取消标志", async () => {
    const redis = createReader(null);
    const guard = new CancellationGuard(redis);

    await guard.isCancelled(runId);

    expect(redis.get).toHaveBeenCalledOnce();
    expect(redis.get).toHaveBeenCalledWith(`run:${runId}:cancelled`);
  });

  it("取消标志为1时返回true", async () => {
    const guard = new CancellationGuard(createReader("1"));

    await expect(guard.isCancelled(runId)).resolves.toBe(true);
  });

  it.each([null, "0", "true", ""])("取消标志为%j时返回false", async (value) => {
    const guard = new CancellationGuard(createReader(value));

    await expect(guard.isCancelled(runId)).resolves.toBe(false);
  });

  it("拒绝非法runId且不查询Redis", async () => {
    const redis = createReader("1");
    const guard = new CancellationGuard(redis);

    await expect(guard.isCancelled("not-a-uuid")).rejects.toBeDefined();
    expect(redis.get).not.toHaveBeenCalled();
  });
});

describe("CancellationGuard.assertNotCancelled", () => {
  it("任务未取消时正常返回", async () => {
    const guard = new CancellationGuard(createReader(null));

    await expect(guard.assertNotCancelled(runId)).resolves.toBeUndefined();
  });

  it("任务已取消时抛出不可重试错误", async () => {
    const guard = new CancellationGuard(createReader("1"));

    const action = guard.assertNotCancelled(runId);

    await expect(action).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(action).rejects.toThrow(
      `Research run ${runId} has been cancelled`,
    );
  });
});
