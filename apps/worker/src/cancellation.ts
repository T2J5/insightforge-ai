import { ResearchRunJobSchema } from "@insightforge/domain";
import { UnrecoverableError } from "bullmq";

/**
 * 根据 runId 生成 run:<runId>:cancelled。
查询 Redis 取消标志。
标志值为 "1" 时阻止 Worker 继续执行。
抛出 UnrecoverableError，避免 BullMQ 重试一个已经取消的任务。
通过依赖注入隔离 Redis
 *
*/
export interface CancellationReader {
  get(key: string): Promise<string | null>;
}

const getCancellationKey = (runId: string): string => {
  const job = ResearchRunJobSchema.parse({ runId });
  return `run:${job.runId}:cancelled`;
};

export class CancellationGuard {
  constructor(private readonly redis: CancellationReader) {}

  async isCancelled(runId: string): Promise<boolean> {
    const value = await this.redis.get(getCancellationKey(runId));
    return value === "1";
  }

  async assertNotCancelled(runId: string): Promise<void> {
    if (await this.isCancelled(runId)) {
      throw new UnrecoverableError(`Research run ${runId} has been cancelled`);
    }
  }
}
