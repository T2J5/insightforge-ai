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

/**
 * 固定窗口限流通过一段 Lua 脚本完成，而不是先 INCR、再 EXPIRE。
 *
 * Redis 会原子执行整段脚本，其他请求不能插入两条命令之间。否则进程恰好
 * 在 INCR 后崩溃时，计数键可能永远没有过期时间，用户也就会被永久限流。
 * 这是“固定窗口”算法：首次请求开启一个窗口，窗口到期后计数整体清零；
 * 它实现简单，但相邻两个窗口边界处允许短时间内出现两倍于额度的请求。
 */

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
    // 键中不直接保存 ownerId，避免运维查看 Redis 时看到原始身份信息。
    // SHA-256 在这里是不可逆标识/假名化，不是加密，也不能替代访问控制。
    const subjectHash = createHash("sha256").update(subject).digest("hex");
    const key = `rate-limit:${policy.name}:${subjectHash}`;
    const raw = await this.redis.eval(
      ATOMIC_FIXED_WINDOW_SCRIPT,
      1,
      key,
      policy.windowSeconds,
    );
    // Redis/Lua 的返回值属于外部运行时数据，不能仅靠 TypeScript 类型断言。
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error("RATE_LIMIT_REDIS_RESULT_INVALID");
    }
    const count = Number(raw[0]);
    const ttl = Number(raw[1]);
    if (!Number.isInteger(count) || count < 1 || !Number.isFinite(ttl)) {
      throw new Error("RATE_LIMIT_REDIS_RESULT_INVALID");
    }
    // 正常情况下 ttl 为正数。使用策略窗口兜底，避免 Redis 返回 -1/-2 时
    // 向客户端生成已经过期或明显错误的 Retry-After 时间。
    const effectiveTtl = ttl > 0 ? ttl : policy.windowSeconds;
    return {
      allowed: count <= policy.limit,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - count),
      resetAt: new Date(this.now().getTime() + effectiveTtl * 1_000),
    };
  }
}
