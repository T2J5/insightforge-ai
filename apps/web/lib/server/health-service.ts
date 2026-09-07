export type DependencyHealth = {
  status: "up" | "down";
  latencyMs: number;
};

export type HealthReport = {
  status: "ok" | "degraded";
  service: "insightforge-web";
  version: string;
  checkedAt: string;
  dependencies: {
    database: DependencyHealth;
    redis: DependencyHealth;
  };
};

export interface HealthServiceDependencies {
  checkDatabase(): Promise<unknown>;
  checkRedis(): Promise<unknown>;
  now?: () => Date;
  monotonicNow?: () => number;
  version?: string;
}

const checkDependency = async (
  check: () => Promise<unknown>,
  monotonicNow: () => number,
): Promise<DependencyHealth> => {
  const startedAt = monotonicNow();
  try {
    await check();
    return {
      status: "up",
      latencyMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
    };
  } catch {
    return {
      status: "down",
      latencyMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
    };
  }
};

/**
 * 健康检查只返回依赖状态和耗时，不返回连接串、主机名或异常正文。
 * 这样既能供平台探针判断是否接流量，又不会把基础设施细节公开出去。
 */
export const createHealthReport = async ({
  checkDatabase,
  checkRedis,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
  version = process.env.APP_VERSION?.trim() || "development",
}: HealthServiceDependencies): Promise<HealthReport> => {
  const [database, redis] = await Promise.all([
    checkDependency(checkDatabase, monotonicNow),
    checkDependency(checkRedis, monotonicNow),
  ]);
  return {
    status:
      database.status === "up" && redis.status === "up" ? "ok" : "degraded",
    service: "insightforge-web",
    version,
    checkedAt: now().toISOString(),
    dependencies: { database, redis },
  };
};
