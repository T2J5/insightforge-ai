import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase } from "@insightforge/db";
import IORedis from "ioredis";

export interface WorkerHealthDependencies {
  checkDatabase(): Promise<unknown>;
  checkRedis(): Promise<unknown>;
}

export const checkWorkerDependencies = async ({
  checkDatabase,
  checkRedis,
}: WorkerHealthDependencies): Promise<void> => {
  const results = await Promise.allSettled([checkDatabase(), checkRedis()]);
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("WORKER_DEPENDENCY_HEALTHCHECK_FAILED");
  }
};

const requireEnvironment = (name: "DATABASE_URL" | "REDIS_URL"): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

/** Docker HEALTHCHECK 的独立进程入口，不依赖 Worker 内部单例。 */
export const runWorkerHealthcheck = async (): Promise<void> => {
  const database = createDatabase(requireEnvironment("DATABASE_URL"), {
    maxConnections: 1,
    connectTimeoutSeconds: 3,
  });
  const redis = new IORedis(requireEnvironment("REDIS_URL"), {
    lazyConnect: true,
    connectTimeout: 3_000,
    maxRetriesPerRequest: 0,
  });
  try {
    await checkWorkerDependencies({
      checkDatabase: async () => database.client`select 1`,
      checkRedis: async () => redis.ping(),
    });
  } finally {
    await Promise.allSettled([database.close(), redis.quit()]);
  }
};

const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await runWorkerHealthcheck();
}
