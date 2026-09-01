import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestIdentity: vi.fn(),
  getUploadService: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({
  resolveRequestIdentity: mocks.resolveRequestIdentity,
}));
vi.mock("@/lib/server/upload-service-provider", () => ({
  getUploadService: mocks.getUploadService,
}));

import { POST } from "./route";

const runId = "550e8400-e29b-41d4-a716-446655440000";

const request = (providedRunId = runId) => {
  const form = new FormData();
  form.set("runId", providedRunId);
  form.append(
    "files",
    new Blob(["private strategy"], { type: "text/plain" }),
    "strategy.txt",
  );
  return new NextRequest("http://localhost/api/uploads", {
    method: "POST",
    body: form,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveRequestIdentity.mockReturnValue({
    ownerId: "anonymous:owner-1",
  });
  mocks.getUploadService.mockReturnValue({ upload: mocks.upload });
  mocks.upload.mockResolvedValue([
    {
      documentId: "c0a80121-7ac0-4b18-9f20-6d9ad634b573",
      status: "ready",
      chunkCount: 1,
      reused: false,
    },
  ]);
});

describe("POST /api/uploads", () => {
  it("使用服务端身份上传 multipart 文件", async () => {
    const input = request();
    const response = await POST(input);
    expect(response.status).toBe(201);
    expect(mocks.resolveRequestIdentity).toHaveBeenCalledWith(input);
    expect(mocks.upload).toHaveBeenCalledWith("anonymous:owner-1", runId, [
      expect.objectContaining({ name: "strategy.txt", type: "text/plain" }),
    ]);
  });

  it("非法 runId 在创建身份和服务前返回 400", async () => {
    const response = await POST(request("not-a-uuid"));
    expect(response.status).toBe(400);
    expect(mocks.resolveRequestIdentity).not.toHaveBeenCalled();
    expect(mocks.getUploadService).not.toHaveBeenCalled();
  });
});
