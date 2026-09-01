import type {
  DocumentStatus,
  EmbeddingPort,
  SupportedDocumentType,
} from "@insightforge/domain";

import { chunkDocument, type DocumentChunkDraft } from "./chunk";
import type { DocumentParser } from "./parsers";

export interface StoredDocument {
  id: string;
  runId: string;
  ownerId: string;
  title: string;
  originalName: string;
  type: SupportedDocumentType;
  mimeType: string;
  fileSize: number;
  contentHash: string;
  storageKey: string;
  status: DocumentStatus;
  errorCode: string | null;
}

export interface ObjectStoragePort {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export interface DocumentIngestStore {
  findByOwnerHash(
    ownerId: string,
    contentHash: string,
  ): Promise<StoredDocument | null>;
  createPending(input: {
    runId: string;
    ownerId: string;
    title: string;
    originalName: string;
    type: SupportedDocumentType;
    mimeType: string;
    fileSize: number;
    contentHash: string;
    storageKey: string;
  }): Promise<StoredDocument>;
  getOwned(documentId: string, ownerId: string): Promise<StoredDocument | null>;
  attachToRun(
    documentId: string,
    runId: string,
    ownerId: string,
  ): Promise<void>;
  countForRun(runId: string, ownerId: string): Promise<number>;
  setStatus(
    documentId: string,
    ownerId: string,
    status: DocumentStatus,
    errorCode: string | null,
  ): Promise<void>;
  complete(
    documentId: string,
    ownerId: string,
    title: string,
    chunks: Array<DocumentChunkDraft & { embedding: number[] }>,
  ): Promise<void>;
}

export interface IngestResult {
  documentId: string;
  status: "ready";
  chunkCount: number;
  reused: boolean;
}

const publicErrorCode = (error: unknown): string => {
  if (error instanceof Error) {
    const allowed = new Set([
      "DOCUMENT_EMPTY",
      "DOCUMENT_EMPTY_OR_SCANNED",
      "DOCUMENT_PARSE_FAILED",
      "EMBEDDING_PROVIDER_ERROR",
      "EMBEDDING_DIMENSION_MISMATCH",
      "EMBEDDING_TIMEOUT",
    ]);
    if (allowed.has(error.message)) return error.message;
  }
  return "DOCUMENT_INGEST_FAILED";
};

export class DocumentIngestor {
  constructor(
    private readonly store: DocumentIngestStore,
    private readonly storage: ObjectStoragePort,
    private readonly parser: DocumentParser,
    private readonly embeddings: EmbeddingPort,
  ) {}

  async ingest(ownerId: string, documentId: string): Promise<IngestResult> {
    /** 所有权检查发生在读取对象存储之前，避免通过文档 ID 探测私有文件。 */
    const document = await this.store.getOwned(documentId, ownerId);
    if (!document) throw new Error("DOCUMENT_NOT_ACCESSIBLE");
    if (document.status === "ready") {
      return { documentId, status: "ready", chunkCount: 0, reused: true };
    }

    await this.store.setStatus(documentId, ownerId, "processing", null);
    try {
      const bytes = await this.storage.get(document.storageKey);
      const parsed = await this.parser.parse({
        type: document.type,
        displayName: document.originalName,
        bytes,
      });
      const chunks = chunkDocument(parsed);
      /** 分批生成向量；所有批次成功之前不写任何可搜索 Chunk。 */
      const vectors: number[][] = [];
      for (let offset = 0; offset < chunks.length; offset += 32) {
        const batch = chunks.slice(offset, offset + 32);
        vectors.push(
          ...(await this.embeddings.embed(batch.map((chunk) => chunk.content))),
        );
      }
      if (
        vectors.length !== chunks.length ||
        vectors.some((vector) => vector.length !== this.embeddings.dimensions)
      ) {
        throw new Error("EMBEDDING_DIMENSION_MISMATCH");
      }
      /** complete 在单个 PostgreSQL 事务内替换 Chunk 并把文档标记为 ready。 */
      await this.store.complete(
        documentId,
        ownerId,
        parsed.title,
        chunks.map((chunk, index) => ({
          ...chunk,
          embedding: vectors[index]!,
        })),
      );
      return {
        documentId,
        status: "ready",
        chunkCount: chunks.length,
        reused: false,
      };
    } catch (error) {
      /** 只持久化允许公开展示的稳定错误码，不保存供应商响应和内部堆栈。 */
      await this.store.setStatus(
        documentId,
        ownerId,
        "failed",
        publicErrorCode(error),
      );
      throw error;
    }
  }
}
