import type IORedis from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeWorkerRedis, createWorkerRedis, getWorkerRedis } from "./redis";

const connections: IORedis[] = [];

const trackConnection = (connection: IORedis): IORedis => {
  connections.push(connection);
  return connection;
};

afterEach(async () => {
  await closeWorkerRedis();

  for (const connection of connections.splice(0)) {
    connection.disconnect();
  }

  vi.unstubAllEnvs();
});

describe("createWorkerRedis", () => {
  it.each(["", "   "])("拒绝空Redis URL：%j", (redisUrl) => {
    expect(() => createWorkerRedis(redisUrl)).toThrowError(
      "REDIS_URL_REQUIRED",
    );
  });

  it("拒绝无法解析的Redis URL", () => {
    expect(() => createWorkerRedis("not a url")).toThrowError(
      "REDIS_URL_INVALID",
    );
  });

  it("拒绝Redis以外的协议", () => {
    expect(() => createWorkerRedis("https://localhost:6379")).toThrowError(
      "REDIS_URL_UNSUPPORTED_PROTOCOL",
    );
  });

  it("拒绝缺少主机名的Redis URL", () => {
    expect(() => createWorkerRedis("redis:///1")).toThrowError(
      "REDIS_URL_INVALID",
    );
  });

  it.each(["redis://localhost:6379/0", "rediss://example.com:6380/1"])(
    "接受%s协议",
    (redisUrl) => {
      const connection = trackConnection(createWorkerRedis(redisUrl));

      expect(connection).toBeDefined();
      expect(connection.status).toBe("wait");
    },
  );

  it("创建符合BullMQ Worker要求的惰性连接", () => {
    const connection = trackConnection(
      createWorkerRedis(" redis://localhost:6379/1 "),
    );

    expect(connection.options.maxRetriesPerRequest).toBeNull();
    expect(connection.options.enableReadyCheck).toBe(true);
    expect(connection.options.lazyConnect).toBe(true);
    expect(connection.options.connectTimeout).toBe(10_000);
    expect(connection.status).toBe("wait");
  });

  it("每次调用工厂函数都创建独立连接", () => {
    const first = trackConnection(
      createWorkerRedis("redis://localhost:6379/1"),
    );
    const second = trackConnection(
      createWorkerRedis("redis://localhost:6379/1"),
    );

    expect(first).not.toBe(second);
  });
});

describe("getWorkerRedis", () => {
  it("没有配置REDIS_URL时快速失败", () => {
    vi.stubEnv("REDIS_URL", "");

    expect(() => getWorkerRedis()).toThrowError("REDIS_URL_REQUIRED");
  });

  it("在同一进程中复用Worker连接", () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379/1");

    const first = trackConnection(getWorkerRedis());
    const second = getWorkerRedis();

    expect(second).toBe(first);
    expect(first.status).toBe("wait");
  });
});

describe("closeWorkerRedis", () => {
  it("关闭后允许创建新的 Worker Redis 连接", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379/1");

    const first = trackConnection(getWorkerRedis());

    await closeWorkerRedis();

    const second = trackConnection(getWorkerRedis());
    expect(second).not.toBe(first);
  });

  it("没有连接或重复关闭时保持幂等", async () => {
    await expect(closeWorkerRedis()).resolves.toBeUndefined();
    await expect(closeWorkerRedis()).resolves.toBeUndefined();
  });
});
