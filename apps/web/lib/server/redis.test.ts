import type IORedis from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProducerRedis, getProducerRedis } from "./redis";

const connections: IORedis[] = [];

const trackConnection = (connection: IORedis): IORedis => {
  connections.push(connection);

  return connection;
};

afterEach(() => {
  for (const connection of connections.splice(0)) {
    connection.disconnect();
  }

  vi.unstubAllEnvs();
});

describe("createProducerRedis", () => {
  it.each(["", "   "])("拒绝空Redis URL：%j", (redisUrl) => {
    expect(() => createProducerRedis(redisUrl)).toThrowError(
      "REDIS_URL_REQUIRED",
    );
  });

  it("拒绝无法解析的Redis URL", () => {
    expect(() => createProducerRedis("not a url")).toThrowError(
      "REDIS_URL_INVALID",
    );
  });

  it("拒绝Redis以外的协议", () => {
    expect(() => createProducerRedis("https://localhost:6379")).toThrowError(
      "REDIS_URL_UNSUPPORTED_PROTOCOL",
    );
  });

  it("拒绝缺少主机名的Redis URL", () => {
    expect(() => createProducerRedis("redis:///1")).toThrowError(
      "REDIS_URL_INVALID",
    );
  });

  it.each(["redis://localhost:6379/0", "rediss://example.com:6380/1"])(
    "接受%s协议",
    (redisUrl) => {
      const connection = trackConnection(createProducerRedis(redisUrl));

      expect(connection).toBeDefined();
      expect(connection.status).toBe("wait");
    },
  );

  it("创建适合Web Producer快速失败的惰性连接", () => {
    const connection = trackConnection(
      createProducerRedis(" redis://localhost:6379/1 "),
    );

    expect(connection.options.maxRetriesPerRequest).toBe(1);
    expect(connection.options.enableReadyCheck).toBe(true);
    expect(connection.options.lazyConnect).toBe(true);
    expect(connection.options.connectTimeout).toBe(10_000);
    expect(connection.status).toBe("wait");
  });

  it("每次调用工厂函数都创建独立连接", () => {
    const first = trackConnection(
      createProducerRedis("redis://localhost:6379/1"),
    );
    const second = trackConnection(
      createProducerRedis("redis://localhost:6379/1"),
    );

    expect(first).not.toBe(second);
  });
});

describe("getProducerRedis", () => {
  it("没有配置REDIS_URL时快速失败", () => {
    vi.stubEnv("REDIS_URL", "");

    expect(() => getProducerRedis()).toThrowError("REDIS_URL_REQUIRED");
  });

  it("在同一进程中复用Producer连接", () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379/1");

    const first = trackConnection(getProducerRedis());
    const second = getProducerRedis();

    expect(second).toBe(first);
    expect(first.status).toBe("wait");
  });
});
