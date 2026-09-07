import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/api-response";
import { getDatabaseConnection } from "@/lib/server/database";
import {
  createDeploymentSmokeRun,
  isValidSmokeToken,
} from "@/lib/server/smoke-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = async (request: Request): Promise<NextResponse> => {
  if (
    !isValidSmokeToken(
      request.headers.get("authorization"),
      process.env.SMOKE_TEST_TOKEN,
    )
  ) {
    return errorResponse(401, "SMOKE_UNAUTHORIZED", "冒烟测试凭据无效");
  }
  try {
    const result = await createDeploymentSmokeRun(getDatabaseConnection().db);
    return NextResponse.json(result, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return errorResponse(503, "SMOKE_UNAVAILABLE", "冒烟测试暂时不可用");
  }
};
