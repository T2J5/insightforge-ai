import { createDatabase, type DatabaseConnection } from "@insightforge/db";

let workerDatabaseConnection: DatabaseConnection | undefined;

/**
 * 获取 Worker 进程共享的数据库连接。
 *
 * Worker 是长期运行的独立 Node.js 进程，不需要使用
 * Next.js 开发热更新场景中的 globalThis 缓存。
 */
export const getWorkerDatabaseConnection = (): DatabaseConnection => {
  if (workerDatabaseConnection) {
    return workerDatabaseConnection;
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL_REQUIRED");
  }

  workerDatabaseConnection = createDatabase(databaseUrl, {
    /**
     * 这是单个 Worker 进程允许使用的最大数据库连接数。
     * 后续部署多个 Worker 副本时，总连接数约等于：
     * Worker 副本数 × maxConnections。
     */
    maxConnections: 5,
    /**
     * 空闲连接保留20秒，之后允许连接池释放它。
     */
    idleTimeoutSeconds: 20,
    /**
     * 建立数据库连接最多等待10秒。
     */
    connectTimeoutSeconds: 10,
  });
  return workerDatabaseConnection;
};
/**
 * 关闭 Worker 数据库连接。
 *
 * Worker 收到 SIGTERM 或 SIGINT 时调用，
 * 确保容器退出以前释放PostgreSQL连接。
 */
export const closeWorkerDatabaseConnection = async (): Promise<void> => {
  const connection = workerDatabaseConnection;
  if (!connection) {
    return;
  }

  /**
   * 先清除缓存。
   *
   * 即使close抛出异常，后续也不会取得一个正在关闭的连接。
   */
  workerDatabaseConnection = undefined;
  await connection.close();
};
