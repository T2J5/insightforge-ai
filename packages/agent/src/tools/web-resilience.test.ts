import { describe, expect, it, vi } from "vitest";

import {
  HostnameConcurrencyLimiter,
  RetryableWebError,
  retryWebOperation,
} from "./web-resilience";

describe("retryWebOperation", () => {
  it("retries only RetryableWebError and preserves the final code", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new RetryableWebError("SEARCH_RATE_LIMITED"));
    const sleep = vi.fn(async () => undefined);

    await expect(
      retryWebOperation(operation, {
        maxAttempts: 2,
        retryDelayMs: 250,
        deadlineAt: Date.now() + 10_000,
        sleep,
      }),
    ).rejects.toThrow("SEARCH_RATE_LIMITED");

    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not retry permanent errors", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("PAGE_TOO_LARGE"));
    const sleep = vi.fn(async () => undefined);

    await expect(
      retryWebOperation(operation, {
        maxAttempts: 2,
        retryDelayMs: 250,
        deadlineAt: Date.now() + 10_000,
        sleep,
      }),
    ).rejects.toThrow("PAGE_TOO_LARGE");

    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("HostnameConcurrencyLimiter", () => {
  it("does not let one hostname block a different hostname", async () => {
    const limiter = new HostnameConcurrencyLimiter(1);
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = limiter.run("a.example.com", async () => firstPending);
    const secondOperation = vi.fn(async () => "second");

    await expect(limiter.run("b.example.com", secondOperation)).resolves.toBe(
      "second",
    );
    expect(secondOperation).toHaveBeenCalledOnce();

    releaseFirst?.();
    await first;
  });
});
