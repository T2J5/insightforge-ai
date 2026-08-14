/**
 * 职责：
    1. 读取并校验 DATABASE_URL；
    2. 创建 postgres客户端；
    3. 使用Drizzle包装；
    4. 导出数据库类型；
    5. 支持测试结束时关闭连接。
*/
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export type PostgresClient = ReturnType<typeof postgres>;

export type DatabaseConnection = {
  db: Database;
  client: PostgresClient;
  close: () => Promise<void>;
};

export type CreateDatabaseOptions = {
  maxConnections?: number;
  idleTimeoutSeconds?: number;
  connectTimeoutSeconds?: number;
};

const validateDatabaseUrl = (databaseUrl: string): string => {
  const value = databaseUrl.trim();

  if (value.length === 0) {
    throw new Error("DATABASE_URL_REQUIRED");
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL_INVALID");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL_UNSUPPORTED_PROTOCOL");
  }

  return value;
};

export const createDatabase = (
  databaseUrl: string,
  options: CreateDatabaseOptions = {},
): DatabaseConnection => {
  const url = validateDatabaseUrl(databaseUrl);

  const client = postgres(url, {
    max: options.maxConnections ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
  });

  const db = drizzle(client, {
    schema,
  });

  let closed = false;

  return {
    db,
    client,
    close: async () => {
      if (closed) {
        return;
      }

      closed = true;

      await client.end({
        timeout: 5,
      });
    },
  };
};
