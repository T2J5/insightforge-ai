import { resolveRequestIdentity } from "@/lib/server/auth";
import { RunDispatchError, RunGovernanceError } from "@/lib/server/run-service";
import { getRunService } from "@/lib/server/run-service-provider";
import {
  CreateRunRequestSchema,
  type CreateRunRequest,
} from "@insightforge/domain";
import { NextResponse, type NextRequest } from "next/server";
import { applyIdentityCookie, errorResponse } from "@/lib/server/api-response";

/**
 * auth.ts使用node:crypto，因此明确使用Node.js Runtime。
 */
export const runtime = "nodejs";

const parseRequestBody = async (
  request: NextRequest,
): Promise<
  | {
      success: true;
      data: CreateRunRequest;
    }
  | {
      success: false;
      response: NextResponse;
    }
> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      success: false,
      response: errorResponse(400, "INVALID_JSON", "请求体不是有效的 JSON。"),
    };
  }
  const parsed = CreateRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      success: false,
      response: errorResponse(
        400,
        "INVALID_REQUEST",
        "创建调研任务的参数无效",
        parsed.error.issues.map((issue) => ({
          path: issue.path.length > 0 ? issue.path.map(String).join(".") : "$",
          message: issue.message,
          code: issue.code,
        })),
      ),
    };
  }
  return {
    success: true,
    data: parsed.data,
  };
};

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  /**
   * 先解析请求体。
   *
   * 无效请求不应该创建匿名Session Cookie，
   * 也不应该初始化数据库或Redis连接。
   */
  const parsedBody = await parseRequestBody(request);
  if (!parsedBody.success) {
    return parsedBody.response;
  }
  try {
    /**
     * ownerId只能来自经过服务端签名验证的Cookie，
     * 不能从请求体读取。
     */
    const identity = resolveRequestIdentity(request);
    const runService = getRunService();
    const run = await runService.createRun(identity.ownerId, parsedBody.data);
    const response = NextResponse.json(
      { runId: run.id, status: run.status },
      {
        status: 202,
      },
    );
    return applyIdentityCookie(response, identity);
  } catch (error) {
    if (error instanceof RunGovernanceError) {
      if (error.code === "DEEP_RESEARCH_NOT_ALLOWED") {
        return errorResponse(403, error.code, "当前账号没有深度调研权限");
      }
      const response = errorResponse(429, error.code, "今日调研额度已用完");
      if (error.details) {
        response.headers.set("X-RateLimit-Limit", String(error.details.limit));
        response.headers.set(
          "X-RateLimit-Remaining",
          String(error.details.remaining),
        );
        response.headers.set(
          "X-RateLimit-Reset",
          error.details.resetAt.toISOString(),
        );
        response.headers.set(
          "Retry-After",
          String(
            Math.max(
              1,
              Math.ceil((error.details.resetAt.getTime() - Date.now()) / 1_000),
            ),
          ),
        );
      }
      return response;
    }
    /**
     * 数据库记录已经创建，但Checkpoint或BullMQ入队失败。
     * 这是暂时性基础设施错误，使用503提示客户端稍后重试。
     */
    if (error instanceof RunDispatchError) {
      return errorResponse(503, error.code, "调研任务暂时无法加入执行队列");
    }
    /**
     * 不向客户端暴露数据库地址、Redis错误、
     * AUTH_SECRET配置或内部堆栈。
     */
    return errorResponse(500, "INTERNAL_ERROR", "服务器暂时无法创建调研任务");
  }
};
