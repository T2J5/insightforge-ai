import { createHash, timingSafeEqual } from "node:crypto";

import { errorResponse } from "@/lib/server/api-response";
import { getDatabaseConnection } from "@/lib/server/database";
import { researchRuns, usageEvents } from "@insightforge/db";
import { ResearchRunJobSchema } from "@insightforge/domain";
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

interface SafeUsageEvent {
  provider: string;
  model: string | null;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostCny: number;
  latencyMs: number | null;
  cacheHit: boolean | null;
  retryCount: number | null;
  node: string | null;
  createdAt: string;
}

export interface AdminUsageQuery {
  get(runId: string): Promise<{
    run: { tokenUsage: number; estimatedCostCny: number } | null;
    events: SafeUsageEvent[];
  }>;
}

const hashToken = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

const isAdmin = (request: NextRequest, expectedToken: string): boolean => {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || !expectedToken) return false;
  return timingSafeEqual(
    hashToken(authorization.slice("Bearer ".length)),
    hashToken(expectedToken),
  );
};

export const createAdminUsageHandler =
  (query: AdminUsageQuery, expectedToken: () => string) =>
  async (
    request: NextRequest,
    context: { params: Promise<{ runId: string }> },
  ): Promise<NextResponse> => {
    if (!isAdmin(request, expectedToken())) {
      return errorResponse(403, "ADMIN_REQUIRED", "需要管理员权限");
    }
    const parsed = ResearchRunJobSchema.safeParse(await context.params);
    if (!parsed.success) {
      return errorResponse(400, "INVALID_RUN_ID", "调研任务ID格式无效");
    }
    const result = await query.get(parsed.data.runId);
    if (!result.run) {
      return errorResponse(404, "RUN_NOT_FOUND", "调研任务不存在");
    }
    const response = NextResponse.json({
      runId: parsed.data.runId,
      tokenUsage: result.run.tokenUsage,
      estimatedCostCny: result.run.estimatedCostCny,
      events: result.events,
    });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };

const databaseQuery: AdminUsageQuery = {
  async get(runId) {
    const { db } = getDatabaseConnection();
    const [run] = await db
      .select({
        tokenUsage: researchRuns.tokenUsage,
        estimatedCostCny: researchRuns.estimatedCostCny,
      })
      .from(researchRuns)
      .where(eq(researchRuns.id, runId))
      .limit(1);
    const rows = await db
      .select({
        provider: usageEvents.provider,
        model: usageEvents.model,
        operation: usageEvents.operation,
        inputTokens: usageEvents.inputTokens,
        outputTokens: usageEvents.outputTokens,
        estimatedCostCny: usageEvents.estimatedCostCny,
        metadata: usageEvents.metadata,
        createdAt: usageEvents.createdAt,
      })
      .from(usageEvents)
      .where(eq(usageEvents.runId, runId));
    return {
      run: run
        ? {
            tokenUsage: run.tokenUsage,
            estimatedCostCny: Number(run.estimatedCostCny),
          }
        : null,
      events: rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        operation: row.operation,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        estimatedCostCny: Number(row.estimatedCostCny),
        latencyMs:
          typeof row.metadata.latencyMs === "number"
            ? row.metadata.latencyMs
            : null,
        cacheHit:
          typeof row.metadata.cacheHit === "boolean"
            ? row.metadata.cacheHit
            : null,
        retryCount:
          typeof row.metadata.retryCount === "number"
            ? row.metadata.retryCount
            : null,
        node: typeof row.metadata.node === "string" ? row.metadata.node : null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  },
};

export const GET = createAdminUsageHandler(
  databaseQuery,
  () => process.env.ADMIN_API_TOKEN?.trim() ?? "",
);
