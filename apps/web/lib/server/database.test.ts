import { createDatabase, type DatabaseConnection } from "@insightforge/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabaseConnection, getDatabaseConnection } from "./database";

vi.mock("@insightforge/db", () => ({
  createDatabase: vi.fn(),
}));

type TestDatabaseGlobal = typeof globalThis & {
  __insightforgeDatabaseConnection?: DatabaseConnection;
};

const databaseGlobal = globalThis as TestDatabaseGlobal;

const createFakeConnection = () => {
  const close = vi.fn().mockResolvedValue(undefined);

  return {
    connection: {
      db: {},
      client: {},
      close,
    } as unknown as DatabaseConnection,
    close,
  };
};

beforeEach(() => {
  delete databaseGlobal.__insightforgeDatabaseConnection;
  vi.mocked(createDatabase).mockReset();
});

afterEach(() => {
  delete databaseGlobal.__insightforgeDatabaseConnection;
  vi.unstubAllEnvs();
});

describe("getDatabaseConnection", () => {
  it("没有配置DATABASE_URL时快速失败", () => {
    vi.stubEnv("DATABASE_URL", "");

    expect(() => getDatabaseConnection()).toThrowError("DATABASE_URL_REQUIRED");
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("使用固定连接池配置创建并复用数据库连接", () => {
    const { connection } = createFakeConnection();

    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://insightforge:insightforge@localhost:5432/insightforge",
    );
    vi.mocked(createDatabase).mockReturnValue(connection);

    const first = getDatabaseConnection();
    const second = getDatabaseConnection();

    expect(first).toBe(connection);
    expect(second).toBe(first);
    expect(createDatabase).toHaveBeenCalledTimes(1);
    expect(createDatabase).toHaveBeenCalledWith(
      "postgresql://insightforge:insightforge@localhost:5432/insightforge",
      {
        maxConnections: 10,
        idleTimeoutSeconds: 20,
        connectTimeoutSeconds: 10,
      },
    );
  });
});

describe("closeDatabaseConnection", () => {
  it("没有缓存连接时安全返回", async () => {
    await expect(closeDatabaseConnection()).resolves.toBeUndefined();
  });

  it("关闭连接并清除单例缓存", async () => {
    const first = createFakeConnection();
    const second = createFakeConnection();

    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://insightforge:insightforge@localhost:5432/insightforge",
    );
    vi.mocked(createDatabase)
      .mockReturnValueOnce(first.connection)
      .mockReturnValueOnce(second.connection);

    expect(getDatabaseConnection()).toBe(first.connection);

    await closeDatabaseConnection();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(getDatabaseConnection()).toBe(second.connection);
    expect(createDatabase).toHaveBeenCalledTimes(2);
  });

  it("即使关闭失败也不会继续复用旧连接", async () => {
    const closeError = new Error("database close failed");
    const first = createFakeConnection();
    const second = createFakeConnection();

    first.close.mockRejectedValueOnce(closeError);
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://insightforge:insightforge@localhost:5432/insightforge",
    );
    vi.mocked(createDatabase)
      .mockReturnValueOnce(first.connection)
      .mockReturnValueOnce(second.connection);

    getDatabaseConnection();

    await expect(closeDatabaseConnection()).rejects.toBe(closeError);
    expect(getDatabaseConnection()).toBe(second.connection);
  });
});
