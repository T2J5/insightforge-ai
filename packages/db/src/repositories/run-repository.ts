import {
  CreateResearchRunSchema,
  ResearchRunSchema,
  RunCheckpointInputSchema,
  RunCheckpointSchema,
  RunStatusSchema,
  type CreateResearchRun,
  type ResearchRun,
  type RunCheckpoint,
  type RunCheckpointInput,
  type RunStatus,
} from "@insightforge/domain";
import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import { researchRuns, runCheckpoints } from "../schema";

function toResearchRun(row: typeof researchRuns.$inferSelect): ResearchRun {
  return ResearchRunSchema.parse({
    ...row,
    estimatedCostCny: Number(row.estimatedCostCny),
  });
}

export class RunRepository {
  constructor(private readonly database: Database) {}

  async create(input: CreateResearchRun): Promise<ResearchRun> {
    const values = CreateResearchRunSchema.parse(input);
    const [created] = await this.database
      .insert(researchRuns)
      .values(values)
      .returning();

    if (!created) {
      throw new Error("RUN_CREATE_FAILED");
    }
    return toResearchRun(created);
  }

  async get(runId: string): Promise<ResearchRun | null> {
    const [run] = await this.database
      .select()
      .from(researchRuns)
      .where(eq(researchRuns.id, runId))
      .limit(1);
    return run ? toResearchRun(run) : null;
  }

  async transition(
    runId: string,
    expected: RunStatus,
    next: RunStatus,
  ): Promise<ResearchRun> {
    const expectedStatus = RunStatusSchema.parse(expected);
    const nextStatus = RunStatusSchema.parse(next);
    const [updated] = await this.database
      .update(researchRuns)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(
        and(
          eq(researchRuns.id, runId),
          eq(researchRuns.status, expectedStatus),
        ),
      )
      .returning();

    if (!updated) {
      throw new Error("RUN_STATUS_CONFLICT");
    }
    return toResearchRun(updated);
  }

  async saveCheckpoint(
    runId: string,
    checkpoint: RunCheckpointInput,
  ): Promise<RunCheckpoint> {
    const value = RunCheckpointInputSchema.parse(checkpoint);
    return this.database.transaction(async (transaction) => {
      const [saved] = await transaction
        .insert(runCheckpoints)
        .values({ runId, ...value })
        .onConflictDoUpdate({
          target: [runCheckpoints.runId, runCheckpoints.checkpointKey],
          set: { state: value.state, updatedAt: new Date() },
        })
        .returning();

      if (!saved) {
        throw new Error("RUN_CHECKPOINT_SAVE_FAILED");
      }
      return RunCheckpointSchema.parse(saved);
    });
  }
}
