import { describe, expect, it, vi } from "vitest";

import type {
  DocumentIngestStore,
  IngestResult,
  ObjectStoragePort,
  StoredDocument,
} from "@insightforge/retrieval";

import { UploadService, sanitizeDisplayName } from "./upload-service";
import type { UploadValidationError } from "./upload-service";

const runId = "550e8400-e29b-41d4-a716-446655440000";
const documentId = "c0a80121-7ac0-4b18-9f20-6d9ad634b573";
const textBytes = new TextEncoder().encode("private acquisition strategy");

const file = (
  overrides: Partial<{ name: string; type: string; bytes: Uint8Array }> = {},
) => {
  const bytes = overrides.bytes ?? textBytes;
  return {
    name: overrides.name ?? "strategy.txt",
    type: overrides.type ?? "text/plain",
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    },
  };
};

const createHarness = (existing: StoredDocument | null = null) => {
  const document: StoredDocument = existing ?? {
    id: documentId,
    runId,
    ownerId: "user-a",
    title: "strategy",
    originalName: "strategy.txt",
    type: "text",
    mimeType: "text/plain",
    fileSize: textBytes.byteLength,
    contentHash: "a".repeat(64),
    storageKey: "documents/fixed.text",
    status: "pending",
    errorCode: null,
  };
  const authorizer = { assertOwned: vi.fn(async () => undefined) };
  const store = {
    findByOwnerHash: vi.fn(async () => existing),
    createPending: vi.fn(async () => document),
    attachToRun: vi.fn(async () => undefined),
    countForRun: vi.fn(async () => 0),
  } as unknown as DocumentIngestStore;
  const storage: ObjectStoragePort = {
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => textBytes),
    delete: vi.fn(async () => undefined),
  };
  const result: IngestResult = {
    documentId,
    status: "ready",
    chunkCount: 1,
    reused: false,
  };
  const ingestor = { ingest: vi.fn(async () => result) };
  const service = new UploadService(
    authorizer,
    store,
    storage,
    ingestor as never,
    () => "fixed",
  );
  return { service, authorizer, store, storage, ingestor, document };
};

describe("UploadService", () => {
  it("校验归属后用随机存储键保存并摄取文档", async () => {
    const harness = createHarness();
    await expect(
      harness.service.upload("user-a", runId, [file()]),
    ).resolves.toEqual([
      expect.objectContaining({ documentId, status: "ready" }),
    ]);
    expect(harness.authorizer.assertOwned).toHaveBeenCalledWith(
      runId,
      "user-a",
    );
    expect(harness.storage.put).toHaveBeenCalledWith(
      "documents/fixed.text",
      textBytes,
      "text/plain",
    );
    expect(harness.store.createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "user-a",
        originalName: "strategy.txt",
        storageKey: "documents/fixed.text",
      }),
    );
  });

  it("相同 owner 和内容哈希已经 ready 时复用索引", async () => {
    const existing = { ...createHarness().document, status: "ready" as const };
    const harness = createHarness(existing);
    const result = await harness.service.upload("user-a", runId, [file()]);
    expect(result[0]).toMatchObject({ documentId, reused: true });
    expect(harness.storage.put).not.toHaveBeenCalled();
    expect(harness.ingestor.ingest).not.toHaveBeenCalled();
  });

  it.each([
    [file({ name: "payload.exe" }), "UPLOAD_TYPE_UNSUPPORTED"],
    [
      file({ name: "report.pdf", type: "application/pdf" }),
      "UPLOAD_SIGNATURE_INVALID",
    ],
    [
      file({ name: "report.txt", type: "application/pdf" }),
      "UPLOAD_TYPE_UNSUPPORTED",
    ],
  ])("拒绝扩展名、MIME 或魔数不一致", async (input, code) => {
    await expect(
      createHarness().service.upload("user-a", runId, [input]),
    ).rejects.toMatchObject({
      code,
    } satisfies Partial<UploadValidationError>);
  });

  it("每次最多十个文件", async () => {
    await expect(
      createHarness().service.upload(
        "user-a",
        runId,
        Array.from({ length: 11 }, () => file()),
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_FILE_COUNT_INVALID" });
  });

  it("同一个 Run 累计最多关联十个文档", async () => {
    const harness = createHarness();
    vi.mocked(harness.store.countForRun).mockResolvedValueOnce(10);
    await expect(
      harness.service.upload("user-a", runId, [file()]),
    ).rejects.toMatchObject({ code: "UPLOAD_RUN_FILE_LIMIT_EXCEEDED" });
  });

  it("文件显示名不会成为目录路径", () => {
    expect(sanitizeDisplayName("../../private\\plan.txt")).toBe(
      ".._.._private_plan.txt",
    );
  });
});
