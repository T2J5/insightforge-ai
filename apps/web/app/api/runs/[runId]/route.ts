import { applyIdentityCookie, errorResponse } from "@/lib/server/api-response";
import {
  resolveRequestIdentity,
  type RequestIdentity,
} from "@/lib/server/auth";
import { RunQueryError } from "@/lib/server/run-service";
import { getRunService } from "@/lib/server/run-service-provider";
import { ResearchRunJobSchema } from "@insightforge/domain";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

type RunRouteContext = {
  params: Promise<{ runId: string }>;
};

export const GET = async (
  request: NextRequest,
  context: RunRouteContext,
): Promise<NextResponse> => {
  const params = await context.params;
  /**
   * 先校验runId。
   *
   * 非法UUID不创建匿名Cookie，也不访问数据库。
   */
  const parsedRunId = ResearchRunJobSchema.safeParse({
    runId: params.runId,
  });

  if (!parsedRunId.success) {
    return errorResponse(400, "INVALID_RUN_ID", "调研任务ID格式无效");
  }

  let identity: RequestIdentity;

  try {
    identity = resolveRequestIdentity(request);
  } catch {
    /**
     * AUTH_SECRET配置错误等内部异常不能暴露给客户端。
     */
    return errorResponse(500, "INTERNAL_ERROR", "服务器暂时无法验证用户身份");
  }

  try {
    const runService = getRunService();

    const run = await runService.getRun(
      identity.ownerId,
      parsedRunId.data.runId,
    );
    /**
     * 不返回ownerId。
     *
     * 即使这是当前用户自己的任务，前端也不需要知道
     * 数据库内部使用的所有者标识。
     */
    const response = NextResponse.json(
      {
        runId: run.id,
        company: run.company,
        focus: run.focus,
        depth: run.depth,
        status: run.status,
        tokenUsage: run.tokenUsage,
        estimatedCostCny: run.estimatedCostCny,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      },
      {
        status: 200,
      },
    );
    /**
     * 这是用户私有响应，禁止共享缓存。
     */
    response.headers.set("Cache-Control", "private, no-store");
    return applyIdentityCookie(response, identity);
  } catch (error) {
    if (error instanceof RunQueryError) {
      return applyIdentityCookie(
        errorResponse(404, error.code, "调研任务不存在"),
        identity,
      );
    }

    return applyIdentityCookie(
      errorResponse(500, "INTERNAL_ERROR", "服务器暂时无法查询调研任务"),
      identity,
    );
  }
};
