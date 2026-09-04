import { createHash } from "node:crypto";

export interface RateLimitPolicy {
  name: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
}

export interface RedisScriptExecutor {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

const ATOMIC_FIXED_WINDOW_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("TTL", KEYS[1])
return {count, ttl}
`;

export const guestQuickPolicy: RateLimitPolicy = {
  name: "guest-quick-daily",
  limit: 1,
  windowSeconds: 86_400,
};

export const authenticatedQuickPolicy: RateLimitPolicy = {
  name: "authenticated-quick-daily",
  limit: 5,
  windowSeconds: 86_400,
};

export class RedisRateLimiter {
  constructor(
    private readonly redis: RedisScriptExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async consume(
    subject: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitResult> {
    if (!subject.trim()) throw new Error("RATE_LIMIT_SUBJECT_REQUIRED");
    if (!Number.isInteger(policy.limit) || policy.limit < 1) {
      throw new Error("RATE_LIMIT_POLICY_INVALID");
    }
    if (!Number.isInteger(policy.windowSeconds) || policy.windowSeconds < 1) {
      throw new Error("RATE_LIMIT_POLICY_INVALID");
    }
    const subjectHash = createHash("sha256").update(subject).digest("hex");
    const key = `rate-limit:${policy.name}:${subjectHash}`;
    const raw = await this.redis.eval(
      ATOMIC_FIXED_WINDOW_SCRIPT,
      1,
      key,
      policy.windowSeconds,
    );
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error("RATE_LIMIT_REDIS_RESULT_INVALID");
    }
    const count = Number(raw[0]);
    const ttl = Number(raw[1]);
    if (!Number.isInteger(count) || count < 1 || !Number.isFinite(ttl)) {
      throw new Error("RATE_LIMIT_REDIS_RESULT_INVALID");
    }
    const effectiveTtl = ttl > 0 ? ttl : policy.windowSeconds;
    return {
      allowed: count <= policy.limit,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - count),
      resetAt: new Date(this.now().getTime() + effectiveTtl * 1_000),
    };
  }
}
