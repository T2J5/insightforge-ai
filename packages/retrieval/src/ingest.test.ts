import { describe, expect, it, vi } from "vitest";
import type { EmbeddingPort } from "@insightforge/domain";
import {
  DocumentIngestor,
  type DocumentIngestStore,
  type ObjectStoragePort,
  type StoredDocument,
} from "./ingest";

const document: StoredDocument = {
  id: "c0a80121-7ac0-4b18-9f20-6d9ad634b573",
  runId: "550e8400-e29b-41d4-a716-446655440000",
  ownerId: "user-a",
  title: "Document",
  originalName: "document.txt",
  type: "text",
  mimeType: "text/plain",
  fileSize: 4,
  contentHash: "a".repeat(64),
  storageKey: "documents/a.text",
  status: "pending",
  errorCode: null,
};

const createHarness = () => {
  const store = {
    getOwned: vi.fn(async () => document),
    setStatus: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
  } as unknown as DocumentIngestStore;
  const storage: ObjectStoragePort = {
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => new TextEncoder().encode("company strategy")),
    delete: vi.fn(async () => undefined),
  };
  const parser = {
    parse: vi.fn(async () => ({
      title: "Company Strategy",
      pages: [
        { pageNumber: 1, headings: ["Strategy"], text: "company strategy" },
      ],
    })),
  };
  const embeddings: EmbeddingPort = {
    dimensions: 3,
    embed: vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0, 0])),
  };
  return {
    store,
    ingestor: new DocumentIngestor(store, storage, parser, embeddings),
  };
};

describe("DocumentIngestor", () => {
  it("所有 chunk 准备完成后才原子提交 ready", async () => {
    const harness = createHarness();
    const result = await harness.ingestor.ingest("user-a", document.id);
    expect(result).toMatchObject({
      status: "ready",
      chunkCount: 1,
      reused: false,
    });
    expect(harness.store.setStatus).toHaveBeenNthCalledWith(
      1,
      document.id,
      "user-a",
      "processing",
      null,
    );
    expect(harness.store.complete).toHaveBeenCalledWith(
      document.id,
      "user-a",
      "Company Strategy",
      [expect.objectContaining({ embedding: [1, 0, 0] })],
    );
  });

  it("解析失败时标记 failed 且不提交任何 chunk", async () => {
    const harness = createHarness();
    const failing = new DocumentIngestor(
      harness.store,
      {
        put: vi.fn(),
        get: vi.fn(async () => new Uint8Array()),
        delete: vi.fn(),
      },
      {
        parse: vi.fn(async () => {
          throw new Error("DOCUMENT_EMPTY");
        }),
      },
      { dimensions: 3, embed: vi.fn() },
    );
    await expect(failing.ingest("user-a", document.id)).rejects.toThrow(
      "DOCUMENT_EMPTY",
    );
    expect(harness.store.complete).not.toHaveBeenCalled();
    expect(harness.store.setStatus).toHaveBeenLastCalledWith(
      document.id,
      "user-a",
      "failed",
      "DOCUMENT_EMPTY",
    );
  });
});
