export interface ManagedResearchWorker {
  waitUntilReady(): Promise<unknown>;
  close(): Promise<unknown>;
}
export interface WorkerRuntimeDependencies {
  worker: ManagedResearchWorker;
  closeRedis: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  closeCheckpointer: () => Promise<void>;
}
/**
 * 管理 Worker 进程中的资源生命周期。
 *
 * 启动：
 * 等待 BullMQ Worker 与 Redis 建立连接。
 *
 * 关闭：
 * 先停止 Worker，等待正在处理的 Job 完成，
 * 再释放 Redis 和 PostgreSQL。
 */
export class WorkerRuntime {
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly dependencies: WorkerRuntimeDependencies) {}

  start(): Promise<void> {
    if (this.closePromise) {
      return Promise.reject(new Error("WORKER_RUNTIME_CLOSED"));
    }

    if (!this.startPromise) {
      this.startPromise = this.dependencies.worker
        .waitUntilReady()
        .then(() => undefined);
    }
    return this.startPromise;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.performClose();
    }
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    const errors: unknown[] = [];
    /**
     * 必须先停止 Worker。
     *
     * BullMQ Worker.close() 会停止领取新任务，
     * 并等待正在运行的任务结束。
     */
    try {
      await this.dependencies.worker.close();
    } catch (error) {
      errors.push(error);
    }

    /**
     * 即使 Worker.close() 失败，
     * Redis 和 PostgreSQL 也必须继续尝试关闭。
     */
    const resourceResults = await Promise.allSettled([
      this.dependencies.closeRedis(),
      this.dependencies.closeDatabase(),
      this.dependencies.closeCheckpointer(),
    ]);

    for (const result of resourceResults) {
      if (result.status === "rejected") {
        errors.push(result.reason);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "WORKER_SHUTDOWN_FAILED");
    }
  }
}
