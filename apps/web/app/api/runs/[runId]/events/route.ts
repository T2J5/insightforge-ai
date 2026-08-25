import { ResearchRunJobSchema } from "@insightforge/domain";
import { NextResponse } from "next/server";
import { type NextRequest } from "next/server";

import { applyIdentityCookie, errorResponse } from "@/lib/server/api-response";
import {
  resolveRequestIdentity,
  type RequestIdentity,
} from "@/lib/server/auth";
import { getRunService } from "@/lib/server/run-service-provider";
import { RunQueryError } from "@/lib/server/run-service";
import {
  createRunEventSubscriber,
  getRunEventReader,
} from "@/lib/server/run-event-stream-provider";
import { createRunEventStream } from "@/lib/server/run-event-stream";

export const runtime = "nodejs";
/**
 * SSE 不能被 Next.js 静态生成或缓存。
 */
export const dynamic = "force-dynamic";

type RunEventsRouteContext = {
  params: Promise<{
    runId: string;
  }>;
};

const applyPrivateResponse = (
  response: NextResponse,
  identity: RequestIdentity,
): NextResponse => {
  return applyIdentityCookie(response, identity);
};

/**
 * Last-Event-ID 必须是非负安全整数。
 *
 * 合法：
 * - 0
 * - 1
 * - 120
 *
 * 非法：
 * - -1
 * - 1.5
 * - " 1 "
 * - abc
 */
const parseLastEventId = (request: NextRequest): number | null => {
  const rawValue = request.headers.get("last-event-id");
  if (rawValue === null) {
    return 0;
  }
  if (!/^(0|[1-9]\d*)$/.test(rawValue)) {
    return null;
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value)) {
    return null;
  }
  return value;
};

export const GET = async (
  request: NextRequest,
  context: RunEventsRouteContext,
): Promise<NextResponse> => {
  const params = await context.params;
  const parsedRunId = ResearchRunJobSchema.safeParse({
    runId: params.runId,
  });

  if (!parsedRunId.success) {
    return errorResponse(400, "INVALID_RUN_ID", "调研任务ID格式无效");
  }
  const lastEventId = parseLastEventId(request);

  if (lastEventId === null) {
    return errorResponse(
      400,
      "INVALID_LAST_EVENT_ID",
      "Last-Event-ID 格式无效",
    );
  }

  let identity: RequestIdentity;
  try {
    identity = resolveRequestIdentity(request);
  } catch {
    return errorResponse(500, "INTERNAL_ERROR", "服务器暂时无法验证用户身份");
  }
  const runId = parsedRunId.data.runId;
  let run;
  try {
    /**
     * 必须先验证任务所有权，再创建 Redis Subscriber。
     *
     * 否则攻击者可以为其他用户的任务建立事件订阅。
     */
    run = await getRunService().getRun(identity.ownerId, runId);
  } catch (error) {
    if (error instanceof RunQueryError) {
      return applyPrivateResponse(
        errorResponse(404, "RUN_NOT_FOUND", "调研任务不存在或不属于当前用户"),
        identity,
      );
    }

    return applyPrivateResponse(
      errorResponse(500, "INTERNAL_ERROR", "服务器暂时无法查询调研任务"),
      identity,
    );
  }

  try {
    const reader = getRunEventReader();
    const subscriber = createRunEventSubscriber();
    const stream = createRunEventStream({
      runId,
      currentStatus: run.status,
      lastEventId,
      reader,
      subscriber,
      signal: request.signal,
    });

    const response = new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "private, no-cache",
        Connection: "keep-alive",
        /**
         * 禁止 Nginx 缓冲事件，否则浏览器无法实时收到进度。
         */
        "X-Accel-Buffering": "no",
      },
    });
    return applyPrivateResponse(response, identity);
  } catch {
    return applyPrivateResponse(
      errorResponse(503, "RUN_EVENTS_UNAVAILABLE", "调研进度服务暂时不可用"),
      identity,
    );
  }
};
