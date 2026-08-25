import {
  getRunEventRedisKeys,
  RUN_EVENT_LOG_LIMIT,
  RunProgressEventSchema,
  type RunProgressEvent,
  type RunStatus,
} from "@insightforge/domain";

export interface RunEventReader {
  // Redis List LRANGE 命令, 用于读取历史事件日志
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}
/**
 * Redis 订阅，用于接收实时事件。
 */
export interface RunEventSubscriber {
  // Redis Pub/Sub SUBSCRIBE 命令, 用于订阅实时事件频道
  subscribe(channel: string): Promise<unknown>;
  // Redis Pub/Sub UNSUBSCRIBE 命令, 用于取消订阅实时事件频道
  unsubscribe(channel: string): Promise<unknown>;
  // Redis Pub/Sub message 事件监听器, 用于接收实时事件消息
  on(
    eventName: "message",
    listener: (channel: string, message: string) => void,
  ): unknown;
  // Redis Pub/Sub message 事件移除监听器, 用于取消接收实时事件消息
  off(
    eventName: "message",
    listener: (channel: string, message: string) => void,
  ): unknown;
  // Redis 连接关闭, 用于释放资源
  quit(): Promise<unknown>;
}

/**
 * 创建一个可读流，用于将运行进度事件通过 SSE 发送给浏览器。
 *
 * 该流会：
 * - 回放 Redis 中的历史事件日志；
 * - 订阅 Redis Pub/Sub 实时事件频道；
 * - 发送心跳消息，防止浏览器断开连接。
 *
 * @param options 创建流的选项
 * @returns 可读流
 */
export interface CreateRunEventStreamOptions {
  runId: string;
  /**
   * 数据库中当前任务状态。
   *
   * 如果任务已经处于终态，
   * 回放完 Redis 中的历史事件后立即关闭 SSE。
   */
  currentStatus: RunStatus;
  /**
   * 浏览器通过 Last-Event-ID 提交的最后一个事件 ID。
   */
  lastEventId: number;
  /**
   * 普通 Redis 连接，用于执行 LRANGE。
   */
  reader: RunEventReader;
  /**
   * SSE 连接独占的 Redis Subscriber。
   *
   * Redis 进入订阅模式后不能继续执行 LRANGE，
   * 因此 reader 和 subscriber 必须分开。
   */
  subscriber: RunEventSubscriber;
  /**
   * HTTP 请求取消信号。
   */
  signal?: AbortSignal;
  /**
   * 默认每 15 秒发送一次心跳。
   * 测试可以传入更小的值。
   */
  heartbeatMs?: number;
}
const DEFAULT_HEARTBEAT_MS = 15_000;
const terminalStatuses: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);
/**
 * 文本编码器，用于将事件编码成 SSE 格式。
 */
const encoder = new TextEncoder();

/**
 * 把领域事件编码成标准 SSE 格式。
 *
 * 最后的两个空字符串会生成两个换行符，
 * 表示一条 SSE 消息结束。
 */
const encodeEvent = (event: RunProgressEvent): Uint8Array =>
  encoder.encode(
    [
      `id: ${event.id}`,
      `event: ${event.type}`,
      `data: ${JSON.stringify(event)}`,
      "",
      "",
    ].join("\n"),
  );

/**
 * 心跳消息的 SSE 编码。
 * 以冒号开头的行会被浏览器忽略，
 * 但可以防止浏览器断开连接。
 */
const encodeHeartbeat = (): Uint8Array => encoder.encode(": heartbeat\n\n");

/**
 * Redis 中的数据属于运行时外部数据，
 * 必须经过 JSON 解析和 Zod 校验。
 */
const parseEvent = (
  serializedEvent: string,
  expectedRunId: string,
): RunProgressEvent | null => {
  let rawEvent: unknown;
  try {
    rawEvent = JSON.parse(serializedEvent);
  } catch {
    return null;
  }
  const parsed = RunProgressEventSchema.safeParse(rawEvent);
  if (!parsed.success) {
    return null;
  }

  if (parsed.data.runId !== expectedRunId) {
    return null;
  }

  return parsed.data;
};
/**
 * 创建一个可读流，用于将运行进度事件通过 SSE 发送给浏览器。
 *
 * 该流会：
 * - 回放 Redis 中的历史事件日志；
 * - 订阅 Redis Pub/Sub 实时事件频道；
 * - 发送心跳消息，防止浏览器断开连接。
 *
 * @param options 创建流的选项
 * @returns 可读流
 */
export const createRunEventStream = ({
  runId,
  currentStatus,
  lastEventId,
  reader,
  subscriber,
  signal,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
}: CreateRunEventStreamOptions): ReadableStream<Uint8Array> => {
  // 验证参数合法性
  if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) {
    throw new Error("LAST_EVENT_ID_INVALID");
  }
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) {
    throw new Error("SSE_HEARTBEAT_INTERVAL_INVALID");
  }
  // 获取 Redis 中的键名
  const keys = getRunEventRedisKeys(runId);
  /**
   * cancel() 需要访问 start() 中创建的清理函数。
   */
  let cleanupConnection: () => Promise<void> = async () => undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let cleaned = false;
      let subscribed = false;
      let replayCompleted = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

      /**
       * 已经发送给浏览器的最大事件 ID。
       *
       * 用于：
       * - 过滤 Last-Event-ID 以前的事件；
       * - 防止历史回放和实时订阅产生重复事件。
       */
      let lastSendId = lastEventId;

      /**
       * Redis 订阅必须发生在读取历史记录之前，
       * 否则二者之间产生的事件可能丢失。
       *
       * 在历史回放完成前收到的实时事件先放入缓冲区。
       */
      const liveEventBuffer: RunProgressEvent[] = [];
      let onMessage: (channel: string, message: string) => void = () =>
        undefined;

      let closeStream: () => void = () => undefined;
      const cleanup = async (): Promise<void> => {
        if (cleaned) return;

        cleaned = true;
        if (heartbeatTimer !== undefined) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
        if (signal) {
          signal.removeEventListener("abort", closeStream);
        }
        try {
          subscriber.off("message", onMessage);
        } catch {
          // ignore
        }
        if (subscribed) {
          try {
            await subscriber.unsubscribe(keys.channel);
          } catch {
            // ignore
          }
        }
        try {
          await subscriber.quit();
        } catch {
          // ignore
        }
      };

      cleanupConnection = cleanup;
      closeStream = (): void => {
        if (closed) return;
        closed = true;

        if (heartbeatTimer !== undefined) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
        controller.close();
        /**
         * ReadableStream 的 close 是同步操作，
         * Redis 清理可以在后台完成。
         */
        void cleanup();
      };
      /**
       * 只有 ID 大于 lastSentId 的事件才能发送。
       */
      const sendEvent = (event: RunProgressEvent): void => {
        if (closed) return;
        if (event.id <= lastSendId) return;
        lastSendId = event.id;
        // 发送事件给浏览器，这里controller.enqueue()是同步的，如果浏览器断开连接会抛出异常。controller 是 ReadableStreamDefaultController<Uint8Array> 类型的对象，表示可读流的控制器。
        controller.enqueue(encodeEvent(event));
        if (terminalStatuses.has(event.status)) {
          closeStream();
        }
      };
      onMessage = (channel, serializedEvent): void => {
        if (closed || channel !== keys.channel) return;

        const event = parseEvent(serializedEvent, runId);
        if (!event || event.id <= lastSendId) return;

        if (!replayCompleted) {
          liveEventBuffer.push(event);
          /**
           * 防止 Redis 回放异常缓慢时缓冲区无限增长。
           */
          if (liveEventBuffer.length > RUN_EVENT_LOG_LIMIT) {
            liveEventBuffer.shift();
          }
          return;
        }
        sendEvent(event);
      };
      if (signal) {
        // 监听请求取消信号，关闭 SSE 流。
        signal.addEventListener("abort", closeStream, { once: true });
        if (signal.aborted) {
          closeStream();
          return;
        }
      }

      try {
        /**
         * 先安装 message listener，再执行 SUBSCRIBE。
         */
        subscriber.on("message", onMessage);
        await subscriber.subscribe(keys.channel);
        subscribed = true;
        if (closed) {
          await cleanup();
          return;
        }
        /**
         * 订阅成功后再读取历史事件。
         *
         * 订阅和 LRANGE 之间产生的事件会进入 liveEventBuffer。
         */
        const serializedHistory = await reader.lrange(keys.log, 0, -1);
        // 解析历史事件，过滤掉 lastSentId 以前的事件，并按 ID 升序排序。
        const historyEvents = serializedHistory
          .map((serializedEvent) => parseEvent(serializedEvent, runId))
          .filter(
            (event): event is RunProgressEvent =>
              event !== null && event.id > lastSendId,
          )
          .sort((l, r) => l.id - r.id);

        for (const event of historyEvents) {
          sendEvent(event);
          if (closed) return;
        }

        replayCompleted = true;
        /**
         * 历史日志可能已经包含缓冲区中的实时事件，
         * sendEvent 会通过 lastSentId 自动去重。
         */
        liveEventBuffer.sort((l, r) => l.id - r.id);
        for (const event of liveEventBuffer) {
          sendEvent(event);
          if (closed) return;
        }
        liveEventBuffer.length = 0;
        /**
         * 数据库已经处于终态，但 Redis 日志中可能没有终态事件。
         * 此时回放完成后也必须关闭连接。
         */
        if (terminalStatuses.has(currentStatus)) {
          closeStream();
          return;
        }
        heartbeatTimer = setInterval(() => {
          if (closed) return;
          controller.enqueue(encodeHeartbeat());
        }, heartbeatMs);
      } catch (err) {
        if (!closed) {
          closed = true;
          controller.error(err);
        }
        await cleanup();
      }
    },
    async cancel() {
      await cleanupConnection();
    },
  });
};
