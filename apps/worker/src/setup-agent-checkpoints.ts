import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import {
  getWorkerAgentCheckpointer,
  closeWorkerAgentCheckpointer,
} from "./checkpointer";

/**
 * 本地执行时加载仓库根目录的 .env。
 *
 * 生产部署时通常由部署平台直接注入 DATABASE_URL。
 */
const localEnvPath = path.join(import.meta.dirname, "../../../.env");
if (existsSync(localEnvPath)) {
  loadEnvFile(localEnvPath);
}
const setupAgentCheckpoints = async () => {
  const checkpointer = getWorkerAgentCheckpointer();
  try {
    /**
     * setup() 会：
     *
     * 1. 创建 langgraph Schema；
     * 2. 创建 Checkpoint 相关表；
     * 3. 执行 Checkpointer 自己的数据库迁移。
     *
     * 该操作具有幂等性，可以重复运行，
     * 但不应该在每个 Job 中执行。
     */
    await checkpointer.setup();
    console.info("LangGraph PostgreSQL checkpoint tables are ready");
  } finally {
    await closeWorkerAgentCheckpointer();
  }
};

await setupAgentCheckpoints();
