import { randomUUID } from "node:crypto";

import {
  getRunEventRedisKeys,
  RUN_EVENT_LOG_LIMIT,
  RUN_EVENT_TTL_SECONDS,
  RunProgressEventSchema,
} from "@insightforge/domain";
import type IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ProgressPublisher } from "./progress-publisher";
import { createWorkerRedis } from "./redis";

const fixedTime = new Date("2026-08-16T08:00:00.000Z");
const redisTestUrl = process.env.REDIS_TEST_URL ?? "redis://localhost:6379/1";

const validInput = (runId: string) => ({
  runId,
  type: "progress" as const,
  status: "running" as const,
  stage: "searching",
  message: "正在搜索企业资料",
  progress: 35,
});

type PublisherRedis = ConstructorParameters<typeof ProgressPublisher>[0];
type ExecResult = Array<[Error | null, unknown]> | null;

const createRedisMock = (execResult: ExecResult) => {
  const transaction = {
    rpush: vi.fn(),
    ltrim: vi.fn(),
    expire: vi.fn(),
    publish: vi.fn(),
    exec: vi.fn().mockResolvedValue(execResult),
  };

  transaction.rpush.mockReturnValue(transaction);
  transaction.ltrim.mockReturnValue(transaction);
  transaction.expire.mockReturnValue(transaction);
  transaction.publish.mockReturnValue(transaction);

  const redis = {
    incr: vi.fn().mockResolvedValue(1),
    multi: vi.fn().mockReturnValue(transaction),
  } as unknown as PublisherRedis;

  return { redis, transaction };
};

describe("ProgressPublisher", () => {
  it("先校验输入，非法事件不会消耗Redis序号", async () => {
    const { redis } = createRedisMock([]);
    const publisher = new ProgressPublisher(redis, () => fixedTime);

    await expect(
      publisher.publish({
        ...validInput(randomUUID()),
        progress: 101,
      }),
    ).rejects.toBeDefined();

    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.multi).not.toHaveBeenCalled();
  });

  it("生成合法事件并按正确顺序写入事务", async () => {
    const runId = randomUUID();
    const keys = getRunEventRedisKeys(runId);
    const { redis, transaction } = createRedisMock([
      [null, 1],
      [null, "OK"],
      [null, 1],
      [null, 1],
      [null, 1],
    ]);
    const publisher = new ProgressPublisher(redis, () => fixedTime);

    const event = await publisher.publish(validInput(runId));
    const serializedEvent = JSON.stringify(event);

    expect(event).toEqual({
      ...validInput(runId),
      id: 1,
      occurredAt: fixedTime.toISOString(),
      data: {},
    });
    expect(RunProgressEventSchema.safeParse(event).success).toBe(true);
    expect(redis.incr).toHaveBeenCalledWith(keys.sequence);
    expect(transaction.rpush).toHaveBeenCalledWith(keys.log, serializedEvent);
    expect(transaction.ltrim).toHaveBeenCalledWith(
      keys.log,
      -RUN_EVENT_LOG_LIMIT,
      -1,
    );
    expect(transaction.expire).toHaveBeenNthCalledWith(
      1,
      keys.log,
      RUN_EVENT_TTL_SECONDS,
    );
    expect(transaction.expire).toHaveBeenNthCalledWith(
      2,
      keys.sequence,
      RUN_EVENT_TTL_SECONDS,
    );
    expect(transaction.publish).toHaveBeenCalledWith(
      keys.channel,
      serializedEvent,
    );
    expect(transaction.exec).toHaveBeenCalledOnce();
  });

  it("事务被中止时抛出稳定错误", async () => {
    const { redis } = createRedisMock(null);
    const publisher = new ProgressPublisher(redis, () => fixedTime);

    await expect(publisher.publish(validInput(randomUUID()))).rejects.toThrow(
      "RUN_PROGRESS_TRANSACTION_ABORTED",
    );
  });

  it("传播事务中单条Redis命令的错误", async () => {
    const redisError = new Error("Redis command failed");
    const { redis } = createRedisMock([
      [null, 1],
      [redisError, null],
    ]);
    const publisher = new ProgressPublisher(redis, () => fixedTime);

    await expect(publisher.publish(validInput(randomUUID()))).rejects.toBe(
      redisError,
    );
  });
});

describe.sequential("ProgressPublisher Redis集成", () => {
  let connection: IORedis;
  let subscriber: IORedis;

  beforeAll(async () => {
    connection = createWorkerRedis(redisTestUrl);
    subscriber = createWorkerRedis(redisTestUrl);
    await Promise.all([connection.connect(), subscriber.connect()]);
  });

  afterAll(async () => {
    await Promise.all([connection.quit(), subscriber.quit()]);
  });

  it("只保留最近200条事件并设置过期时间", async () => {
    const runId = randomUUID();
    const keys = getRunEventRedisKeys(runId);
    const publisher = new ProgressPublisher(connection, () => fixedTime);

    try {
      for (let index = 1; index <= RUN_EVENT_LOG_LIMIT + 1; index += 1) {
        await publisher.publish({
          ...validInput(runId),
          message: `进度事件 ${index}`,
          progress: Math.min(index, 100),
        });
      }

      const stored = await connection.lrange(keys.log, 0, -1);
      const events = stored.map((value) =>
        RunProgressEventSchema.parse(JSON.parse(value)),
      );

      expect(events).toHaveLength(RUN_EVENT_LOG_LIMIT);
      expect(events[0]?.id).toBe(2);
      expect(events.at(-1)?.id).toBe(RUN_EVENT_LOG_LIMIT + 1);
      expect(await connection.get(keys.sequence)).toBe(
        String(RUN_EVENT_LOG_LIMIT + 1),
      );
      expect(await connection.ttl(keys.log)).toBeGreaterThan(0);
      expect(await connection.ttl(keys.sequence)).toBeGreaterThan(0);
    } finally {
      await connection.del(keys.log, keys.sequence);
    }
  });

  it("向约定的Redis频道发布同一事件", async () => {
    const runId = randomUUID();
    const keys = getRunEventRedisKeys(runId);
    const publisher = new ProgressPublisher(connection, () => fixedTime);

    await subscriber.subscribe(keys.channel);

    const receivedMessage = new Promise<string>((resolve) => {
      subscriber.once("message", (_channel, message) => resolve(message));
    });

    try {
      const event = await publisher.publish(validInput(runId));

      await expect(receivedMessage).resolves.toBe(JSON.stringify(event));
    } finally {
      await subscriber.unsubscribe(keys.channel);
      await connection.del(keys.log, keys.sequence);
    }
  });
});
