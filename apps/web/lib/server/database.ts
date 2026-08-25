import { createDatabase, type DatabaseConnection } from "@insightforge/db";

/**
 * 将数据库连接缓存在 globalThis。
 *
 * Next.js 开发模式会发生模块热更新。
 * 使用 globalThis 可以避免每次热更新都创建新的 PostgreSQL 连接池。
 */
type DatabaseGlobal = typeof globalThis & {
  __insightforgeDatabaseConnection?: DatabaseConnection;
};
const databaseGlobal = globalThis as DatabaseGlobal;

/**
 * 获取 Web 进程共享的数据库连接。
 *
 * 注意：
 * - 不在模块加载时创建连接；
 * - 第一次调用时才读取 DATABASE_URL；
 * - 后续调用复用同一个连接池。
 */
export const getDatabaseConnection = (): DatabaseConnection => {
  const cached = databaseGlobal.__insightforgeDatabaseConnection;

  if (cached) {
    return cached;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  /**
   * createDatabase 内部还会继续校验：
   * - 空白字符串；
   * - URL 格式；
   * - PostgreSQL 协议。
   *
   * postgres 客户端通常在第一次查询时才真正建立连接。
   */
  const connection = createDatabase(databaseUrl, {
    maxConnections: 10,
    idleTimeoutSeconds: 20,
    connectTimeoutSeconds: 10,
  });
  databaseGlobal.__insightforgeDatabaseConnection = connection;
  return connection;
};

/**
 * 关闭并清除 Web 数据库连接。
 *
 * 主要用于：
 * - 集成测试结束；
 * - 独立 Node 进程优雅退出；
 * - 后续健康检查或运维脚本。
 *
 * 不应该在每个 HTTP 请求结束时调用。
 */
export const closeDatabaseConnection = async (): Promise<void> => {
  const connection = databaseGlobal.__insightforgeDatabaseConnection;
  if (!connection) return;

  /**
   * 先清除缓存。
   *
   * 即使 close() 发生异常，后续也不会继续取得
   * 一个已经进入关闭过程的连接。
   */
  delete databaseGlobal.__insightforgeDatabaseConnection;
  await connection.close();
};
