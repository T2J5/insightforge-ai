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
  /**
   * timingSafeEqual 要求两侧 Buffer 等长。先哈希既固定了长度，也避免普通
   * 字符串比较的提前返回泄露匹配前缀所需时间。它只降低时序侧信道风险，
   * token 本身仍必须足够随机，并通过环境变量/密钥系统保存。
   */
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
    // 管理员接口使用独立 Bearer Token，不复用匿名 owner Cookie；两类凭证的
    // 权限边界不同，匿名身份只能访问自己的 Run，管理员才可查看成本审计。
    if (!isAdmin(request, expectedToken())) {
      return errorResponse(403, "ADMIN_REQUIRED", "需要管理员权限");
    }
    // 在查询数据库之前验证 UUID，尽早拒绝格式错误输入并统一错误响应。
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
    // 响应含内部成本与模型调用信息，禁止浏览器、代理和 CDN 持久缓存。
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
      // 只投影管理员页面真正需要的字段。metadata 是通用 JSON 列，仍需在
      // 运行时逐字段检查类型，且不能把整个对象原样返回给客户端。
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
