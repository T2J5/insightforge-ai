import { errorResponse } from "@/lib/server/api-response";
import { getPublicReportService } from "@/lib/server/report-service-provider";
import {
  PublishedReportNotFoundError,
  ReportNotPublicError,
} from "@/lib/server/report-service";
import { z } from "zod";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ReportRouteContext = { params: Promise<{ reportId: string }> };

export const GET = async (
  _request: Request,
  context: ReportRouteContext,
): Promise<NextResponse> => {
  const { reportId: value } = await context.params;
  const reportId = z.uuid().safeParse(value);
  if (!reportId.success) {
    return errorResponse(400, "INVALID_REPORT_ID", "报告ID格式无效");
  }

  try {
    const report = await getPublicReportService().getPublished(reportId.data);
    const response = NextResponse.json(report);
    response.headers.set(
      "Cache-Control",
      "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    );
    return response;
  } catch (error) {
    if (error instanceof PublishedReportNotFoundError) {
      return errorResponse(404, error.code, "报告不存在或尚未发布");
    }
    if (error instanceof ReportNotPublicError) {
      return errorResponse(
        403,
        error.code,
        "报告包含私有文档证据，不能通过公开接口访问",
      );
    }
    return errorResponse(500, "INTERNAL_ERROR", "服务器暂时无法读取报告");
  }
};
