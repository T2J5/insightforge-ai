import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const end = vi.fn(async () => undefined);
  const Pool = vi.fn(function MockPool(options: unknown) {
    return { kind: "pool", options };
  });
  const PostgresSaver = vi.fn(function MockPostgresSaver(
    pool: unknown,
    serializer: unknown,
    options: unknown,
  ) {
    return { kind: "checkpointer", pool, serializer, options, end };
  });

  return { end, Pool, PostgresSaver };
});

vi.mock("pg", () => ({
  default: { Pool: mocks.Pool },
}));

vi.mock("@langchain/langgraph-checkpoint-postgres", () => ({
  PostgresSaver: mocks.PostgresSaver,
}));

import {
  closeWorkerAgentCheckpointer,
  createWorkerAgentCheckpointer,
  getWorkerAgentCheckpointer,
} from "./checkpointer";

afterEach(async () => {
  await closeWorkerAgentCheckpointer();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Worker Agent Checkpointer", () => {
  it.each([
    ["空字符串", "   ", "DATABASE_URL_REQUIRED"],
    ["非法 URL", "not-a-url", "DATABASE_URL_INVALID"],
    [
      "不支持的协议",
      "https://database.example.com/insightforge",
      "DATABASE_URL_UNSUPPORTED_PROTOCOL",
    ],
  ])("拒绝%s", (_case, databaseUrl, errorCode) => {
    expect(() => createWorkerAgentCheckpointer(databaseUrl)).toThrow(errorCode);
    expect(mocks.Pool).not.toHaveBeenCalled();
    expect(mocks.PostgresSaver).not.toHaveBeenCalled();
  });

  it("使用受限连接池和独立 langgraph Schema 创建 Checkpointer", () => {
    const checkpointer = createWorkerAgentCheckpointer(
      "  postgresql://user:password@localhost:5432/insightforge  ",
    );

    expect(mocks.Pool).toHaveBeenCalledWith({
      connectionString:
        "postgresql://user:password@localhost:5432/insightforge",
      max: 2,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
    });
    expect(mocks.PostgresSaver).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pool" }),
      undefined,
      { schema: "langgraph" },
    );
    expect(checkpointer).toEqual(
      expect.objectContaining({ kind: "checkpointer" }),
    );
  });

  it("缺少 DATABASE_URL 时不创建连接池", () => {
    vi.stubEnv("DATABASE_URL", "");

    expect(() => getWorkerAgentCheckpointer()).toThrow("DATABASE_URL_REQUIRED");
    expect(mocks.Pool).not.toHaveBeenCalled();
  });

  it("在同一个 Worker 进程中复用 Checkpointer 单例", () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:password@localhost:5432/insightforge",
    );

    const first = getWorkerAgentCheckpointer();
    const second = getWorkerAgentCheckpointer();

    expect(second).toBe(first);
    expect(mocks.Pool).toHaveBeenCalledOnce();
    expect(mocks.PostgresSaver).toHaveBeenCalledOnce();
  });

  it("并发关闭只结束一次连接池并允许之后创建新实例", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:password@localhost:5432/insightforge",
    );
    const first = getWorkerAgentCheckpointer();

    await Promise.all([
      closeWorkerAgentCheckpointer(),
      closeWorkerAgentCheckpointer(),
      closeWorkerAgentCheckpointer(),
    ]);

    expect(mocks.end).toHaveBeenCalledOnce();

    const second = getWorkerAgentCheckpointer();
    expect(second).not.toBe(first);
    expect(mocks.Pool).toHaveBeenCalledTimes(2);
  });
});
