import { applyIdentityCookie, errorResponse } from "@/lib/server/api-response";
import {
  resolveRequestIdentity,
  type RequestIdentity,
} from "@/lib/server/auth";
import { RunCancellationError } from "@/lib/server/run-service";
import { getRunService } from "@/lib/server/run-service-provider";
import { ResearchRunJobSchema } from "@insightforge/domain";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

type CancelRunRouteContext = {
  params: Promise<{
    runId: string;
  }>;
};

const privateResponse = (
  response: NextResponse,
  identity: RequestIdentity,
): NextResponse => {
  response.headers.set("Cache-Control", "private, no-store");
  return applyIdentityCookie(response, identity);
};

export const POST = async (
  request: NextRequest,
  context: CancelRunRouteContext,
): Promise<NextResponse> => {
  const params = await context.params;
  /**
   * 非法ID不创建Session，也不访问数据库。
   */
  const parsedRunId = ResearchRunJobSchema.safeParse({ runId: params.runId });
  if (!parsedRunId.success) {
    return errorResponse(400, "INVALID_RUN_ID", "调研任务ID格式无效");
  }
  let identity: RequestIdentity;
  try {
    identity = resolveRequestIdentity(request);
  } catch {
    return errorResponse(500, "INTERNAL_ERROR", "服务器暂时无法验证用户身份");
  }

  try {
    const runService = getRunService();
    await runService.cancelRun(identity.ownerId, parsedRunId.data.runId);
    return privateResponse(
      NextResponse.json(
        { runId: parsedRunId.data.runId, status: "cancelled" },
        {
          status: 202,
        },
      ),
      identity,
    );
  } catch (error) {
    if (error instanceof RunCancellationError) {
      switch (error.code) {
        case "RUN_NOT_FOUND":
          return privateResponse(
            errorResponse(404, "RUN_NOT_FOUND", "调研任务不存在"),
            identity,
          );
        case "RUN_NOT_CANCELLABLE":
          return privateResponse(
            errorResponse(
              409,
              "RUN_NOT_CANCELLABLE",
              "调研任务当前状态不允许取消",
            ),
            identity,
          );
        case "RUN_CANCELLATION_SIGNAL_FAILED":
          return privateResponse(
            errorResponse(
              503,
              "RUN_CANCELLATION_SIGNAL_FAILED",
              "取消状态已保存，但Worker通知暂时失败",
            ),
            identity,
          );
      }
    }
    return privateResponse(
      errorResponse(
        500,
        "INTERNAL_ERROR",
        "服务器暂时无法取消调研任务，请稍后重试",
      ),
      identity,
    );
  }
};
