/**
 * 职责：
      校验 REDIS_URL。
      只接受 redis: 和 rediss:。
      Web 请求侧快速失败。
      使用 maxRetriesPerRequest: 1。
      不在模块加载时立即创建网络连接。
      Next.js 开发热更新时复用连接，避免连接数不断增长。
*/
import IORedis from "ioredis";

/**
 * 挂载在 globalThis 上的 Redis 单例。
 *
 * Next.js 开发模式可能频繁重新加载服务端模块。
 * 如果只使用模块局部变量，每次热更新都可能创建新连接。
 */
type RedisGlobal = typeof globalThis & {
  __insightforgeProducerRedis?: IORedis;
};
const redisGlobal = globalThis as RedisGlobal;

/**
 * 校验并标准化 Redis URL。
 *
 * 支持：
 * - redis://：普通 Redis 连接
 * - rediss://：TLS Redis 连接
 */
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
 * 创建 Web/BullMQ Producer 使用的 Redis 连接。
 *
 * 这是工厂函数：
 * - 每次调用都返回一个新实例；
 * - 方便集成测试使用独立连接；
 * - 不从 process.env 隐式读取配置。
 */
export const createProducerRedis = (redisUrl: string): IORedis => {
  const url = validateRedisUrl(redisUrl);
  const client = new IORedis(url, {
    /**
     * Web 请求不能因为 Redis 不可用而长时间等待。
     *
     * 一条命令最多重试一次，之后快速失败，
     * 由 RunService 把数据库任务补偿为 failed。
     */
    maxRetriesPerRequest: 1,
    /**
     * 等待 Redis 完成 ready 检查后再执行命令。
     */
    enableReadyCheck: true,
    /**
     * 创建对象时不立即连接。
     *
     * 第一条 Redis/BullMQ 命令执行时才建立连接，
     * 避免 Next.js build 和单元测试仅导入模块就访问 Redis。
     */
    lazyConnect: true,
    /**
     * 建立 TCP 连接的最长等待时间。
     */
    connectTimeout: 10_000,
  });
  return client;
};

/**
 * 获取 Web 进程共享的 Redis Producer 连接。
 *
 * 生产代码使用该函数；
 * 测试代码优先直接调用 createProducerRedis，
 * 以便每个测试显式管理和关闭自己的连接。
 */
export const getProducerRedis = (): IORedis => {
  const cached = redisGlobal.__insightforgeProducerRedis;

  /**
   * end 表示连接已经永久关闭，不能继续复用。
   * connecting、ready、reconnecting 等状态仍可复用。
   */
  if (cached && cached.status !== "end") {
    return cached;
  }

  const redisUrl = process.env.REDIS_URL ?? "";
  if (!redisUrl) {
    throw new Error("REDIS_URL_REQUIRED");
  }
  const connection = createProducerRedis(redisUrl);
  redisGlobal.__insightforgeProducerRedis = connection;
  return connection;
};
