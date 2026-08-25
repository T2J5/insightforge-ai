import IORedis from "ioredis";

const validateRedisUrl = (redisUrl: string): string => {
  const value = redisUrl.trim();
  if (value.length === 0) {
    throw new Error("REDIS_URL_REQUIRED");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("REDIS_URL_INVALID");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL_UNSUPPORTED_PROTOCOL");
  }
  if (url.hostname.length === 0) {
    throw new Error("REDIS_URL_INVALID");
  }
  return value;
};
/**
 * 校验空 URL。
校验 URL 格式。
只接受 redis:、rediss:。
maxRetriesPerRequest: null。
enableReadyCheck: true。
lazyConnect: true。
connectTimeout: 10_000。
使用独立的 globalThis.__insightforgeWorkerRedis。
不能复用 __insightforgeProducerRedis。
不在模块导入时连接 Redis。
*/
export const createWorkerRedis = (redisUrl: string): IORedis => {
  const url = validateRedisUrl(redisUrl);

  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    connectTimeout: 10_000,
  });
};

type WorkerRedisGlobal = typeof globalThis & {
  __insightforgeWorkerRedis?: IORedis;
};
const workerRedisGlobal = globalThis as WorkerRedisGlobal;

export const getWorkerRedis = (): IORedis => {
  const cached = workerRedisGlobal.__insightforgeWorkerRedis;

  if (cached && cached.status !== "end") {
    return cached;
  }

  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error("REDIS_URL_REQUIRED");
  }

  const redis = createWorkerRedis(redisUrl);

  workerRedisGlobal.__insightforgeWorkerRedis = redis;

  return redis;
};

/**
 * 关闭 Worker 进程共享的 Redis 连接。
 *
 * Worker 收到 SIGTERM 或 SIGINT 时调用，
 * 防止进程因为 Redis Socket 仍然存在而无法退出。
 */
export const closeWorkerRedis = async (): Promise<void> => {
  const redis = workerRedisGlobal.__insightforgeWorkerRedis;
  if (!redis) return;
  workerRedisGlobal.__insightforgeWorkerRedis = undefined;
  if (redis.status === "end") return;
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
};
