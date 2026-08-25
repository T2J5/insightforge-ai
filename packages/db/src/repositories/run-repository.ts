import {
  CompleteResearchRunInputSchema,
  CreateResearchRunSchema,
  ResearchRunSchema,
  RunCheckpointInputSchema,
  RunCheckpointKeySchema,
  RunCheckpointSchema,
  RunStatusSchema,
  type CompleteResearchRunInput,
  type CreateResearchRun,
  type ResearchRun,
  type RunCheckpoint,
  type RunCheckpointInput,
  type RunStatus,
} from "@insightforge/domain";
import type { Database } from "../client";
import { runCheckpoints, users } from "../schema";
import { researchRuns } from "../schema";
import { and, eq } from "drizzle-orm";

/**
 * 将 research_runs 数据库记录转换为领域对象。
 *
 * PostgreSQL numeric 默认以字符串返回，
 * 因此 estimatedCostCny 需要显式转换成 number。
 *
 * 最后使用 ResearchRunSchema 验证数据库结构
 * 是否仍然符合 Domain 契约。
 */
const toResearchRun = (
  // 从 Drizzle 表定义中推导“查询结果行”的 TypeScript 类型。
  // 根据researchRuns 表定义，自动推导数据库查询返回的一行的类型
  row: typeof researchRuns.$inferSelect,
): ResearchRun =>
  ResearchRunSchema.parse({
    ...row,
    estimatedCostCny: Number(row.estimatedCostCny),
  });

/**
 * 将 run_checkpoints 数据库记录转换为领域对象。
 */
const toRunCheckpoint = (
  row: typeof runCheckpoints.$inferSelect,
): RunCheckpoint => RunCheckpointSchema.parse(row);

/**
 * 校验并标准化查询使用的 checkpointKey。
 *
 * 空字符串使用稳定错误码；
 * 其他格式错误，例如超过128字符，使用 INVALID。
 */
const parseCheckpointKey = (checkpointKey: string): string => {
  if (typeof checkpointKey !== "string" || checkpointKey.trim().length === 0) {
    throw new Error("RUN_CHECKPOINT_KEY_REQUIRED");
  }
  const result = RunCheckpointKeySchema.safeParse(checkpointKey);
  if (!result.success) {
    throw new Error("RUN_CHECKPOINT_KEY_INVALID");
  }
  return result.data;
};

export class RunRepository {
  constructor(private readonly db: Database) {}

  /**
   * 创建一次新的调研任务。
   *
   * id、初始状态、用量和时间由数据库默认值生成。
   */
  async create(input: CreateResearchRun): Promise<ResearchRun> {
    const parsed = CreateResearchRunSchema.parse(input);
    return this.db.transaction(async (transaction) => {
      await transaction
        .insert(users)
        .values({
          id: parsed.ownerId,
          email: null,
        })
        .onConflictDoNothing({ target: users.id });
      const [row] = await transaction
        .insert(researchRuns)
        .values(parsed)
        // PostgreSQL 支持插入或更新后立即返回结果,减少一次数据库往返，也避免查询期间数据发生变化。
        .returning();

      if (!row) {
        throw new Error("RUN_CREATE_FAILED");
      }
      return toResearchRun(row);
    });
  }

  /**
   * 根据任务ID查询任务。
   *
   * 没有找到时返回 null，而不是抛出异常。
   */
  async get(runId: string): Promise<ResearchRun | null> {
    const [row] = await this.db
      .select()
      .from(researchRuns)
      .where(eq(researchRuns.id, runId))
      .limit(1);
    return row ? toResearchRun(row) : null;
  }

  /**
   * 使用乐观并发控制更新任务状态。
   *
   * 只有数据库中的当前状态等于 expected 时，
   * 才允许更新为 next。
   * 用数据库条件做并发控制
   */
  async transition(
    runId: string,
    expected: RunStatus,
    next: RunStatus,
  ): Promise<ResearchRun> {
    const parsedExpected = RunStatusSchema.parse(expected);
    const parsedNext = RunStatusSchema.parse(next);

    /**
     *
    UPDATE research_runs
    SET
        status = 'running',
        updated_at = now()
    WHERE
        id = ?
        AND status = 'queued'
    RETURNING *;
    */
    const [row] = await this.db
      .update(researchRuns)
      .set({ status: parsedNext, updatedAt: new Date() })
      .where(
        and(
          eq(researchRuns.id, runId),
          eq(researchRuns.status, parsedExpected),
        ),
      )
      .returning();

    if (!row) {
      throw new Error("RUN_STATUS_CONFLICT");
    }
    return toResearchRun(row);
  }

  /**
   * 完成一次正在运行的调研任务，并原子保存用量信息。
   *
   * 状态和用量在同一条 UPDATE 中写入，避免任务已经 completed，
   * 但 tokenUsage 或 estimatedCostCny 仍保留默认值。
   */
  async complete(
    runId: string,
    input: CompleteResearchRunInput,
  ): Promise<ResearchRun> {
    const parsed = CompleteResearchRunInputSchema.parse(input);

    const [row] = await this.db
      .update(researchRuns)
      .set({
        status: "completed",
        tokenUsage: parsed.tokenUsage,
        // PostgreSQL numeric 在 Drizzle 中使用字符串写入。
        estimatedCostCny: parsed.estimatedCostCny.toString(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(researchRuns.id, runId), eq(researchRuns.status, "running")),
      )
      .returning();

    if (!row) {
      throw new Error("RUN_STATUS_CONFLICT");
    }

    return toResearchRun(row);
  }

  /**
   * 保存或更新工作流检查点。
   * 进行幂等保存
   * 相同 runId + checkpointKey 只会保留一条记录。
   * 用 onConflictDoUpdate 做去重和覆盖
   */
  async saveCheckpoint(
    runId: string,
    input: RunCheckpointInput,
  ): Promise<RunCheckpoint> {
    const parsed = RunCheckpointInputSchema.parse(input);

    return this.db.transaction(async (transaction) => {
      const [row] = await transaction
        .insert(runCheckpoints)
        .values({
          runId,
          checkpointKey: parsed.checkpointKey,
          state: parsed.state,
        })
        // 第一次保存 runId + checkpointKey 时插入，后续保存时更新。
        // 第二次保存相同的键会触发唯一索引冲突
        // onConflictDoUpdate 告诉数据库在冲突时更新现有记录，而不是抛出异常。
        /**
        ON CONFLICT (run_id, checkpoint_key)
          DO UPDATE SET
        state = ...,
        updated_at = ...
        */
        .onConflictDoUpdate({
          target: [runCheckpoints.runId, runCheckpoints.checkpointKey],
          set: {
            state: parsed.state,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!row) {
        throw new Error("RUN_CHECKPOINT_SAVE_FAILED");
      }
      return toRunCheckpoint(row);
    });
  }

  /**
   * 读取某个 Run 的指定检查点。
   *
   * 使用 runId 和 checkpointKey 联合查询，
   * 防止不同 Run 或不同工作流阶段的数据串联。
   *
   * 没有找到时返回 null。
   */
  async getCheckpoint(
    runId: string,
    checkpointKey: string,
  ): Promise<RunCheckpoint | null> {
    const parsedCheckpointKey = parseCheckpointKey(checkpointKey);
    const [row] = await this.db
      .select()
      .from(runCheckpoints)
      .where(
        and(
          eq(runCheckpoints.runId, runId),
          eq(runCheckpoints.checkpointKey, parsedCheckpointKey),
        ),
      )
      .limit(1);
    return row ? toRunCheckpoint(row) : null;
  }
}
