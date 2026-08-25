import { RunRepository } from "@insightforge/db";
import { getDatabaseConnection } from "./database";
import { getResearchQueue } from "./research-queue";
import {
  RunService,
  type CancellationStore,
  type ResearchRunQueue,
} from "./run-service";
import { getProducerRedis } from "./redis";

/**
getDatabaseConnection
        ↓
new RunRepository

getResearchQueue
        ↓
BullMQ Queue
        ↓
共享 Producer Redis

getProducerRedis
        ↓
CancellationStore

全部注入 RunService
*/

/**
 * 将组装完成的 RunService 缓存在 globalThis。
 *
 * RunService 本身没有连接资源，但它引用了：
 * - RunRepository；
 * - BullMQ Queue；
 * - Redis。
 *
 * 因此没有必要在每次 API 请求时重复创建。
 */
type RunServiceGlobal = typeof globalThis & {
  __insightforgeRunService?: RunService;
};
const runServiceGlobal = globalThis as RunServiceGlobal;

/**
 * 获取生产环境使用的 RunService。
 */
export const getRunService = (): RunService => {
  const cached = runServiceGlobal.__insightforgeRunService;

  if (cached) {
    return cached;
  }

  const databaseConnection = getDatabaseConnection();
  const repository = new RunRepository(databaseConnection.db);

  const bullQueue = getResearchQueue();
  const redis = getProducerRedis();

  /**
   * 把 BullMQ Queue 显式适配成 RunService 需要的端口。
   *
   * 这样 RunService 不需要依赖 BullMQ 的完整 Queue API。
   */
  const queueAdapter: ResearchRunQueue = {
    add: (name, data, options) => bullQueue.add(name, data, options),
  };
  /**
   * 把 ioredis 显式适配成取消标记端口。
   *
   * RunService 只知道 SET key value EX seconds，
   * 不依赖 ioredis 的其他命令。
   */
  const cancellationStore: CancellationStore = {
    set: (key, value, expirationMode, ttlSeconds) =>
      redis.set(key, value, expirationMode, ttlSeconds),
  };
  const service = new RunService(repository, queueAdapter, cancellationStore);

  runServiceGlobal.__insightforgeRunService = service;
  return service;
};
