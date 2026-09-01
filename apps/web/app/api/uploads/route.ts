import { applyIdentityCookie, errorResponse } from "@/lib/server/api-response";
import { resolveRequestIdentity } from "@/lib/server/auth";
import {
  UploadValidationError,
  type UploadFileLike,
} from "@/lib/server/upload-service";
import { getUploadService } from "@/lib/server/upload-service-provider";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const RunIdSchema = z.uuid();

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const formData = await request.formData();
    const runId = RunIdSchema.safeParse(formData.get("runId"));
    if (!runId.success) {
      return errorResponse(
        400,
        "UPLOAD_RUN_ID_INVALID",
        "缺少有效的调研任务 ID",
      );
    }
    const files = formData
      .getAll("files")
      .filter((entry): entry is File => entry instanceof File);
    // 解析请求中的身份信息，用于所有者隔离
    const identity = resolveRequestIdentity(request);
    const result = await getUploadService().upload(
      identity.ownerId,
      runId.data,
      files satisfies UploadFileLike[],
    );
    return applyIdentityCookie(
      NextResponse.json({ documents: result }, { status: 201 }),
      identity,
    );
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return errorResponse(400, error.code, "上传文件不符合要求");
    }
    if (error instanceof Error && error.message === "RUN_NOT_FOUND") {
      return errorResponse(404, "RUN_NOT_FOUND", "调研任务不存在");
    }
    if (error instanceof Error && error.message.startsWith("DOCUMENT_")) {
      return errorResponse(422, error.message, "文档无法完成解析或索引");
    }
    return errorResponse(500, "UPLOAD_INTERNAL_ERROR", "文档暂时无法上传");
  }
};
