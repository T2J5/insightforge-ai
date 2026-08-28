import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { WorkerRuntime } from "./worker-runtime";
import { ResearchRunFailureHandler } from "./run-failure-handler";
import { createAgentResearchWorkflow } from "./agent-workflow-provider";
import { createResearchRunProcessor } from "./run-processor-provider";
import { closeWorkerRedis, getWorkerRedis } from "./redis";
import {
  closeWorkerDatabaseConnection,
  getWorkerDatabaseConnection,
} from "./database";
import { createResearchWorker } from "./research-worker";
import { ProgressPublisher } from "./progress-publisher";
import { RunRepository } from "@insightforge/db";
import { closeWorkerAgentCheckpointer } from "./checkpointer";

/**
 * 本地开发时加载仓库根目录的 .env。
 *
 * 部署环境通常直接注入环境变量，
 * 因此 .env 不存在时不报错。
 */
const localEnvPath = path.join(import.meta.dirname, "../../../.env");
if (existsSync(localEnvPath)) {
  loadEnvFile(localEnvPath);
}

const main = async () => {
  let runtime: WorkerRuntime | undefined;
  try {
    const workflow = createAgentResearchWorkflow();
    const processor = createResearchRunProcessor(workflow);
    const redis = getWorkerRedis();
    const worker = createResearchWorker(redis, processor);
    runtime = new WorkerRuntime({
      worker,
      closeRedis: closeWorkerRedis,
      closeDatabase: closeWorkerDatabaseConnection,
      closeCheckpointer: closeWorkerAgentCheckpointer,
    });
    /**
     * 最终失败处理器使用相同的数据库和 Redis 单例。
     */
    const database = getWorkerDatabaseConnection();
    const failedHandler = new ResearchRunFailureHandler(
      new RunRepository(database.db),
      new ProgressPublisher(redis),
    );
    worker.on("failed", async (job, error) => {
      failedHandler.handle(job, error).catch((handlerError) => {
        console.error("Failed to finalize research run:", handlerError);
      });
    });

    /**
     * BullMQ 要求 Worker 必须监听 error 事件。
     *
     * 连接错误可能由 BullMQ 自动恢复，
     * 因此这里只记录，不立即退出进程。
     */
    worker.on("error", (error) => {
      console.error("Research Worker error:", error);
    });
    let shutdownPromise: Promise<void> | null = null;

    const shutdown = (signal: "SIGINT" | "SIGTERM") => {
      if (shutdownPromise) {
        return;
      }
      shutdownPromise = (async () => {
        console.info(`${signal} received, shutting down Worker`);
        try {
          await runtime?.close();
          console.info("Research Worker stopped");
        } catch (error) {
          console.error("Error during Worker shutdown:", error);
          process.exitCode = 1;
        }
      })();
    };

    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));

    await runtime.start();
    console.info("Research Worker started");
  } catch (error) {
    console.error("Error during Worker startup:", error);
    process.exitCode = 1;
    if (runtime) {
      try {
        await runtime.close();
      } catch (shutdownError) {
        console.error("Worker startup cleanup failed:", shutdownError);
      }
    } else {
      /**
       * Worker 可能尚未创建，
       * 但 Provider 已经创建了部分连接。
       */
      await Promise.allSettled([
        closeWorkerRedis(),
        closeWorkerDatabaseConnection(),
        closeWorkerAgentCheckpointer(),
      ]);
    }
  }
};

await main();
