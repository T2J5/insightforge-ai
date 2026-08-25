/**
 *
Worker数据库连接 → RunRepository
Worker Redis    → CancellationGuard
Worker Redis    → ProgressPublisher
ResearchWorkflow → ResearchRunProcessor
*/

import { RunRepository } from "@insightforge/db";
import { getWorkerDatabaseConnection } from "./database";
import {
  ResearchRunProcessor,
  type ResearchWorkflow,
} from "./processors/research-run";
import { getWorkerRedis } from "./redis";
import { CancellationGuard } from "./cancellation";
import { ProgressPublisher } from "./progress-publisher";

/**
 * 使用生产环境依赖创建ResearchRunProcessor。
 *
 * workflow由调用方传入，因为真正的LangGraph工作流
 * 要到Task 4才实现。
 */

export const createResearchRunProcessor = (
  workflow: ResearchWorkflow,
): ResearchRunProcessor => {
  const databaseConnection = getWorkerDatabaseConnection();
  const redis = getWorkerRedis();

  const runs = new RunRepository(databaseConnection.db);

  const cancellation = new CancellationGuard(redis);

  const progress = new ProgressPublisher(redis);
  return new ResearchRunProcessor(runs, workflow, progress, cancellation);
};
