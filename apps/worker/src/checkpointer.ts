import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

const { Pool } = pg;

/**
 * LangGraph 使用独立 Schema 保存内部 Checkpoint 表。
 *
 * 不能和业务 run_checkpoints 表混用：
 *
 * - run_checkpoints：业务层请求、最终 Agent 结果；
 * - langgraph.*：LangGraph 节点状态、版本、pending writes。
 */
const LANGGRAPH_CHECKPOINT_SCHEMA = "langgraph";

/**
 * 单个 Worker 的 LangGraph Checkpointer 最多占用两条连接。
 *
 * 当前 Worker 的 Drizzle 连接池最大为 5，
 * 因此单个 Worker 的数据库连接预算约为 5 + 2 = 7。
 */
const CHECKPOINTER_MAX_CONNECTIONS = 2;

const validateDatabaseUrl = (untrustedDatabaseUrl: string): string => {
  const databaseUrl = untrustedDatabaseUrl.trim();
  if (databaseUrl.length === 0) {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL_INVALID");
  }
  if (
    parsedUrl.protocol !== "postgresql:" &&
    parsedUrl.protocol !== "postgres:"
  ) {
    throw new Error("DATABASE_URL_UNSUPPORTED_PROTOCOL");
  }
  return databaseUrl;
};
/**
 * 创建一个独立的 PostgreSQL Checkpointer。
 *
 * 该函数只创建连接池，不调用 setup()。
 * setup() 属于数据库初始化操作，不能在每个 Job 中执行。
 */
export const createWorkerAgentCheckpointer = (
  untrustedDatabaseUrl: string,
): PostgresSaver => {
  const databaseUrl = validateDatabaseUrl(untrustedDatabaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: CHECKPOINTER_MAX_CONNECTIONS,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
  });
  return new PostgresSaver(pool, undefined, {
    schema: LANGGRAPH_CHECKPOINT_SCHEMA,
  });
};

let workerAgentCheckpointer: PostgresSaver | undefined;
/**
 * 获取当前 Worker 进程共享的 Checkpointer。
 *
 * 一个 Worker 中的所有 ResearchRun 共用连接池，
 * 但通过不同的 thread_id 隔离 Checkpoint。
 */
export const getWorkerAgentCheckpointer = (): PostgresSaver => {
  if (workerAgentCheckpointer) {
    return workerAgentCheckpointer;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  workerAgentCheckpointer = createWorkerAgentCheckpointer(databaseUrl);
  return workerAgentCheckpointer;
};
/**
 * 关闭 PostgresSaver 内部拥有的 pg.Pool。
 */
export const closeWorkerAgentCheckpointer = async (): Promise<void> => {
  const checkpointer = workerAgentCheckpointer;
  if (!checkpointer) {
    return;
  }
  workerAgentCheckpointer = undefined;
  await checkpointer.end();
};
