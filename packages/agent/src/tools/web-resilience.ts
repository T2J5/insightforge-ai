export type Sleep = (milliseconds: number) => Promise<void>;

export interface RetryPolicy {
  maxAttempts: number;
  retryDelayMs: number;
  deadlineAt: number;
  sleep: Sleep;
}

export class RetryableWebError extends Error {
  constructor(
    readonly finalCode: string,
    options?: ErrorOptions,
  ) {
    super(finalCode, options);
    this.name = "RetryableWebError";
  }
}

export const defaultSleep: Sleep = async (milliseconds: number) => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const assertPositiveInteger = (value: number, errorCode: string) => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(errorCode);
  }
};

export const retryWebOperation = async <T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
): Promise<T> => {
  assertPositiveInteger(policy.maxAttempts, "WEB_MAX_ATTEMPTS_INVALID");
  assertPositiveInteger(policy.retryDelayMs, "WEB_RETRY_DELAY_INVALID");

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (Date.now() >= policy.deadlineAt) {
      throw new Error("PAGE_TIMEOUT");
    }
    try {
      return await operation(attempt);
    } catch (error) {
      if (!(error instanceof RetryableWebError)) {
        throw error;
      }
      lastError = error;
      if (attempt >= policy.maxAttempts) {
        throw new Error(error.finalCode, { cause: error });
      }

      const remainingMs = policy.deadlineAt - Date.now();
      if (remainingMs <= policy.retryDelayMs) {
        throw new Error("PAGE_TIMEOUT", {
          cause: error,
        });
      }
      await policy.sleep(policy.retryDelayMs);
    }
  }
  throw new Error("WEB_RETRY_EXHAUSTED", { cause: lastError });
};

interface HostnameQueue {
  activeCount: number;
  waiters: Array<() => void>;
}

/**
 * 每个 hostname 独立限流。
 *
 * example.com 达到上限时，不会阻塞 another.com。
 */
export class HostnameConcurrencyLimiter {
  private readonly queues = new Map<string, HostnameQueue>();
  constructor(private readonly maxConcurrencyPerHostname: number) {
    assertPositiveInteger(
      maxConcurrencyPerHostname,
      "WEB_HOST_CONCURRENCY_INVALID",
    );
  }
  async run<T>(hostname: string, operation: () => Promise<T>): Promise<T> {
    await this.acquire(hostname);

    try {
      return await operation();
    } finally {
      this.release(hostname);
    }
  }

  private async acquire(hostname: string): Promise<void> {
    const queue = this.queues.get(hostname) ?? { activeCount: 0, waiters: [] };

    this.queues.set(hostname, queue);

    if (queue.activeCount < this.maxConcurrencyPerHostname) {
      queue.activeCount += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      queue.waiters.push(resolve);
    });
    queue.activeCount += 1;
  }

  private release(hostname: string): void {
    const queue = this.queues.get(hostname);
    if (!queue) {
      return;
    }
    queue.activeCount -= 1;
    const next = queue.waiters.shift();
    if (next) {
      next();
      return;
    }
    if (queue.activeCount === 0) {
      this.queues.delete(hostname);
    }
  }
}

export const readHttpStatusFromError = (error: unknown): number | null => {
  if (!error || typeof error !== "object") {
    return null;
  }
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: {
      status?: unknown;
    };
  };

  const possibleStatuses = [
    candidate.status,
    candidate.statusCode,
    candidate.response?.status,
  ];

  for (const value of possibleStatuses) {
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
  }
  return null;
};
