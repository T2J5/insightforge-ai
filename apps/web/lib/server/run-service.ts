import {
  RESEARCH_RUN_JOB,
  CreateRunRequestSchema,
  ResearchRunJobSchema,
  type CreateResearchRun,
  type RunStatus,
  type CreateRunRequest,
  type ResearchRun,
  type ResearchRunJob,
  type RunCheckpoint,
  type RunCheckpointInput,
} from "@insightforge/domain";
/**
 * RunService 使用的数据库端口。
 *
 * 当前 createRun 阶段只依赖创建任务和保存检查点。
 * 不让业务服务直接依赖 Drizzle 或 Database。
 */
export interface RunRepositoryPort {
  create(input: CreateResearchRun): Promise<ResearchRun>;

  saveCheckpoint(
    runId: string,
    input: RunCheckpointInput,
  ): Promise<RunCheckpoint>;

  transition(
    runId: string,
    expected: RunStatus,
    next: RunStatus,
  ): Promise<ResearchRun>;

  get(runId: string): Promise<ResearchRun | null>;
}
/**
 * 创建数据库任务成功，但后续准备或入队失败。
 *
 * code 用于后续 API 返回稳定错误码；
 * cause 保存 checkpoint 或 Redis 的原始错误；
 * compensationError 保存 queued → failed 补偿失败。
 */
export class RunDispatchError extends Error {
  readonly code = "RUN_DISPATCH_FAILED";
  constructor(
    cause: unknown,
    readonly compensationError?: unknown,
  ) {
    super("Failed to dispatch research run", {
      cause,
    });
    this.name = "RunDispatchError";
  }
}

export type RunCancellationErrorCode =
  | "RUN_NOT_FOUND" // 任务不存在或不属于当前用户
  | "RUN_NOT_CANCELLABLE" // 任务已经完成或失败，不能取消
  | "RUN_CANCELLATION_SIGNAL_FAILED"; // 数据库已取消，但 Redis 标记写入失败

/**
 * 取消任务时的稳定业务错误。
 */
export class RunCancellationError extends Error {
  constructor(
    readonly code: RunCancellationErrorCode,
    cause?: unknown,
  ) {
    super(`Failed to cancel research run: ${code}`, { cause });
    this.name = "RunCancellationError";
  }
}

/**
 * 查询任务时使用的稳定业务错误。
 *
 * 任务不存在和不属于当前用户使用相同错误，
 * 防止攻击者通过接口枚举其他用户的任务。
 */
export class RunQueryError extends Error {
  readonly code = "RUN_NOT_FOUND";
  constructor() {
    super("Research run not found");
    this.name = "RunQueryError";
  }
}

const CANCELLATION_TTL_SECONDS = 24 * 60 * 60;

const CANCELLABLE_STATUSES: ReadonlySet<RunStatus> = new Set([
  "queued",
  "running",
  "awaiting_review",
]);

/**
 * RunService 使用的任务队列端口。
 *
 * 实际运行时会由 BullMQ Queue 实现；
 * 单元测试中使用普通 Mock 对象实现。
 */
export interface ResearchRunQueue {
  add(
    name: typeof RESEARCH_RUN_JOB,
    data: ResearchRunJob,
    options: {
      jobId: string;
    },
  ): Promise<unknown>;
}

/**
 * Redis 取消标记存储端口。
 *
 * 实际运行时由 ioredis 实现；
 * 单元测试使用 Mock。
 */
export interface CancellationStore {
  set(
    key: string,
    value: string,
    expirationMode: "EX",
    ttlSeconds: number,
  ): Promise<unknown>;
}

export interface RunAdmissionPort {
  consume(input: {
    ownerId: string;
    depth: CreateRunRequest["depth"];
  }): Promise<{
    allowed: boolean;
    limit: number;
    remaining: number;
    resetAt: Date;
  }>;
}

export class RunGovernanceError extends Error {
  constructor(
    readonly code: "RUN_RATE_LIMITED" | "DEEP_RESEARCH_NOT_ALLOWED",
    readonly details?: { limit: number; remaining: number; resetAt: Date },
  ) {
    super(code);
    this.name = "RunGovernanceError";
  }
}

/**
 * 负责创建并投递异步调研任务。
 *
 * PostgreSQL 保存权威业务状态；
 * BullMQ 只保存运行任务所需的最小 runId。
 */
export class RunService {
  constructor(
    private readonly runRepository: RunRepositoryPort,
    private readonly queue: ResearchRunQueue,
    private readonly cancellationStore: CancellationStore,
    private readonly admission?: RunAdmissionPort,
  ) {}

  async createRun(
    ownerId: string,
    input: CreateRunRequest,
    access: { deepResearch: boolean } = { deepResearch: false },
  ): Promise<ResearchRun> {
    const request = CreateRunRequestSchema.parse(input);

    if (request.depth === "deep" && !access.deepResearch) {
      throw new RunGovernanceError("DEEP_RESEARCH_NOT_ALLOWED");
    }
    if (this.admission) {
      const quota = await this.admission.consume({
        ownerId,
        depth: request.depth,
      });
      if (!quota.allowed) {
        throw new RunGovernanceError("RUN_RATE_LIMITED", quota);
      }
    }

    /**
     * 先创建数据库记录。
     *
     * Repository/数据库负责生成：
     * - runId；
     * - queued 初始状态；
     * - 创建时间；
     * - 初始用量。
     */
    const run = await this.runRepository.create({
      ownerId,
      company: request.company,
      focus: request.focus,
      depth: request.depth,
    });
    try {
      /**
       * research_runs 表没有 documentIds 字段。
       *
       * 因此把完整原始请求保存为 request checkpoint，
       * 后续 Worker 可以通过 runId 重新加载。
       */
      const checkpointInput: RunCheckpointInput = {
        checkpointKey: "request",
        state: {
          company: request.company,
          focus: request.focus,
          depth: request.depth,
          documentIds: request.documentIds,
        },
      };
      await this.runRepository.saveCheckpoint(run.id, checkpointInput);

      /**
       *  队列中只保存 runId。
       *
       * 使用 Zod 再校验一次跨进程消息协议，
       * 避免 Web 和 Worker 对 Job Data 的理解不一致。
       */
      const jobData = ResearchRunJobSchema.parse({
        runId: run.id,
      });
      /**
       * BullMQ 的 jobId 与数据库 runId 保持一致。
       *
       * 这样同一个 Run 不会因为重复请求而生成多个不同 Job ID，
       * 同时也便于日志和故障排查。
       */
      await this.queue.add(RESEARCH_RUN_JOB, jobData, { jobId: run.id });
      return run;
    } catch (dispatchError) {
      let compensationError: unknown;
      try {
        /**
         * 任务准备或入队失败，数据库状态需要补偿为 failed。
         *
         * 这里使用 queued → failed 状态迁移，
         * 以便后续 API 可以查询到失败的 Run。
         */
        await this.runRepository.transition(run.id, "queued", "failed");
      } catch (error) {
        /**
         * 不直接抛出补偿错误，否则会覆盖最初的失败原因。
         * 将两个错误都保存到 RunDispatchError 中。
         */
        compensationError = error;
      }
      throw new RunDispatchError(dispatchError, compensationError);
    }
  }

  private async writeCancellationSignal(runId: string): Promise<void> {
    try {
      await this.cancellationStore.set(
        `run:${runId}:cancelled`,
        "1",
        "EX",
        CANCELLATION_TTL_SECONDS,
      );
    } catch (cause) {
      throw new RunCancellationError("RUN_CANCELLATION_SIGNAL_FAILED", cause);
    }
  }

  async cancelRun(ownerId: string, runId: string): Promise<void> {
    const parsed = ResearchRunJobSchema.parse({ runId });
    const parsedRunId = parsed.runId;
    const run = await this.runRepository.get(parsedRunId);
    /**
     * 不存在和不属于当前用户统一返回 RUN_NOT_FOUND，
     * 避免泄露其他用户任务是否存在。
     */
    if (!run || run.ownerId !== ownerId) {
      throw new RunCancellationError("RUN_NOT_FOUND");
    }
    /**
     * 重复取消是幂等操作。
     *
     * 不再次执行数据库状态迁移，
     * 但重新写入 Redis 标记，便于恢复上次 Redis 写入失败。
     */
    if (run.status === "cancelled") {
      await this.writeCancellationSignal(parsedRunId);
      return;
    }
    if (!CANCELLABLE_STATUSES.has(run.status)) {
      throw new RunCancellationError("RUN_NOT_CANCELLABLE");
    }

    /**
     * PostgreSQL 是权威状态，因此先迁移数据库状态。
     *
     * transition 使用 expected status，可防止 Worker
     * 并发完成任务时被错误覆盖成 cancelled。
     */
    await this.runRepository.transition(parsedRunId, run.status, "cancelled");
    /**
     * Redis 是 Worker 快速检查的协作式取消信号。
     */
    await this.writeCancellationSignal(parsedRunId);
  }

  /**
   * 查询当前用户拥有的调研任务。
   *
   * ownerId必须来自服务端身份系统，不能来自查询参数。
   */
  async getRun(ownerId: string, runId: string): Promise<ResearchRun> {
    /**
     * 复用跨进程Job Schema校验UUID格式。
     *
     * 这里只取解析后的runId，不接受额外字段。
     */
    const parsed = ResearchRunJobSchema.parse({ runId });
    const run = await this.runRepository.get(parsed.runId);

    /**
     * 不存在和不属于当前用户都返回RUN_NOT_FOUND。
     *
     * 如果分别返回403和404，攻击者就可以判断
     * 某个runId是否真实存在。
     */
    if (!run || run.ownerId !== ownerId) {
      throw new RunQueryError();
    }
    return run;
  }
}
