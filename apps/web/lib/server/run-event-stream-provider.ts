import type { RunEventReader, RunEventSubscriber } from "./run-event-stream";
import { getProducerRedis } from "./redis";

/**
 * 获取共享的普通 Redis 连接。
 *
 * 该连接只负责读取事件日志，
 * 不能进入 Redis Subscriber 模式。
 */
export const getRunEventReader = (): RunEventReader => getProducerRedis();

/**
 * 每一个 SSE 请求创建一个独立 Subscriber。
 *
 * Redis 连接执行 SUBSCRIBE 后会进入订阅模式，
 * 不能继续执行 GET、LRANGE 等普通命令，
 * 因此不能复用共享 Producer 连接。
 */
export const createRunEventSubscriber = (): RunEventSubscriber =>
  getProducerRedis().duplicate({
    lazyConnect: true,
    /**
     * SSE 是长连接，需要允许 Redis 自动重连。
     */
    maxRetriesPerRequest: null,
  });
