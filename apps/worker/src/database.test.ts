import type { DatabaseConnection } from "@insightforge/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDatabase: vi.fn(),
}));

vi.mock("@insightforge/db", () => ({
  createDatabase: mocks.createDatabase,
}));

import {
  closeWorkerDatabaseConnection,
  getWorkerDatabaseConnection,
} from "./database";

const createConnection = (): DatabaseConnection =>
  ({
    db: {},
    client: {},
    close: vi.fn().mockResolvedValue(undefined),
  }) as unknown as DatabaseConnection;

beforeEach(async () => {
  await closeWorkerDatabaseConnection();
  mocks.createDatabase.mockReset();
});

afterEach(async () => {
  await closeWorkerDatabaseConnection();
  vi.unstubAllEnvs();
});

describe("getWorkerDatabaseConnection", () => {
  it("没有配置DATABASE_URL时快速失败", () => {
    vi.stubEnv("DATABASE_URL", "");

    expect(() => getWorkerDatabaseConnection()).toThrowError(
      "DATABASE_URL_REQUIRED",
    );
    expect(mocks.createDatabase).not.toHaveBeenCalled();
  });

  it("使用Worker连接池配置创建数据库连接", () => {
    const connection = createConnection();
    mocks.createDatabase.mockReturnValue(connection);
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:54329/test");

    expect(getWorkerDatabaseConnection()).toBe(connection);
    expect(mocks.createDatabase).toHaveBeenCalledOnce();
    expect(mocks.createDatabase).toHaveBeenCalledWith(
      "postgresql://user:pass@localhost:54329/test",
      {
        maxConnections: 5,
        idleTimeoutSeconds: 20,
        connectTimeoutSeconds: 10,
      },
    );
  });

  it("在同一Worker进程中复用数据库连接", () => {
    const connection = createConnection();
    mocks.createDatabase.mockReturnValue(connection);
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:54329/test");

    const first = getWorkerDatabaseConnection();
    const second = getWorkerDatabaseConnection();

    expect(second).toBe(first);
    expect(mocks.createDatabase).toHaveBeenCalledOnce();
  });
});

describe("closeWorkerDatabaseConnection", () => {
  it("关闭后允许创建新的数据库连接", async () => {
    const first = createConnection();
    const second = createConnection();
    mocks.createDatabase.mockReturnValueOnce(first).mockReturnValueOnce(second);
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:54329/test");

    expect(getWorkerDatabaseConnection()).toBe(first);
    await closeWorkerDatabaseConnection();
    await closeWorkerDatabaseConnection();
    expect(getWorkerDatabaseConnection()).toBe(second);

    expect(first.close).toHaveBeenCalledOnce();
    expect(mocks.createDatabase).toHaveBeenCalledTimes(2);
  });

  it("关闭失败时仍然清除已缓存的连接", async () => {
    const closeError = new Error("database close failed");
    const first = createConnection();
    const second = createConnection();
    vi.mocked(first.close).mockRejectedValueOnce(closeError);
    mocks.createDatabase.mockReturnValueOnce(first).mockReturnValueOnce(second);
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:54329/test");

    expect(getWorkerDatabaseConnection()).toBe(first);
    await expect(closeWorkerDatabaseConnection()).rejects.toBe(closeError);
    expect(getWorkerDatabaseConnection()).toBe(second);
  });
});
