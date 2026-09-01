import { createHash, randomUUID } from "node:crypto";

import type { SupportedDocumentType } from "@insightforge/domain";
import type {
  DocumentIngestStore,
  DocumentIngestor,
  IngestResult,
  ObjectStoragePort,
} from "@insightforge/retrieval";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 10;

export interface UploadFileLike {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface UploadRunAuthorizer {
  assertOwned(runId: string, ownerId: string): Promise<void>;
}

const allowedMimeTypes: Record<SupportedDocumentType, Set<string>> = {
  pdf: new Set(["application/pdf"]),
  docx: new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]),
  markdown: new Set(["text/markdown", "text/plain"]),
  text: new Set(["text/plain"]),
};

const extensionType = (name: string): SupportedDocumentType | null => {
  const extension = /\.([^.]+)$/u.exec(name)?.[1]?.toLowerCase();
  if (extension === "pdf") return "pdf";
  if (extension === "docx") return "docx";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "txt") return "text";
  return null;
};

const hasMagic = (type: SupportedDocumentType, bytes: Uint8Array): boolean => {
  if (type === "pdf")
    return new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
  if (type === "docx") {
    return (
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 0x03 &&
      bytes[3] === 0x04
    );
  }
  return !bytes.slice(0, 8).some((value) => value === 0);
};

export const sanitizeDisplayName = (value: string): string => {
  const withoutControlCharacters = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("");
  const sanitized = withoutControlCharacters.replace(/[\\/]/gu, "_").trim();
  if (!sanitized) throw new Error("UPLOAD_FILENAME_INVALID");
  return sanitized.slice(0, 500);
};

const normalizedContentHash = (
  type: SupportedDocumentType,
  bytes: Uint8Array,
): string => {
  const normalized =
    type === "markdown" || type === "text"
      ? new TextEncoder().encode(
          new TextDecoder("utf-8", { fatal: true })
            .decode(bytes)
            .replace(/\r\n?/gu, "\n")
            .trim(),
        )
      : bytes;
  return createHash("sha256").update(normalized).digest("hex");
};

export class UploadValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class UploadService {
  constructor(
    private readonly authorizer: UploadRunAuthorizer,
    private readonly store: DocumentIngestStore,
    private readonly storage: ObjectStoragePort,
    private readonly ingestor: DocumentIngestor,
    private readonly createId: () => string = randomUUID,
  ) {}

  async upload(
    ownerId: string,
    runId: string,
    files: UploadFileLike[],
  ): Promise<IngestResult[]> {
    /**
     * 请求级限制防止单次占用过多内存；下方 countForRun 是持久化限制，
     * 防止把十一个文件拆成多次请求来绕过上限。
     */
    if (files.length < 1 || files.length > MAX_FILES_PER_UPLOAD) {
      throw new UploadValidationError("UPLOAD_FILE_COUNT_INVALID");
    }
    await this.authorizer.assertOwned(runId, ownerId);
    const currentCount = await this.store.countForRun(runId, ownerId);
    if (currentCount + files.length > MAX_FILES_PER_UPLOAD) {
      throw new UploadValidationError("UPLOAD_RUN_FILE_LIMIT_EXCEEDED");
    }
    const results: IngestResult[] = [];
    /** 先验证整批文件再执行任何写操作，避免后一个非法文件造成前面部分成功。 */
    const validated = [];
    for (const file of files) {
      if (file.size < 1 || file.size > MAX_UPLOAD_BYTES) {
        throw new UploadValidationError("UPLOAD_FILE_SIZE_INVALID");
      }
      const displayName = sanitizeDisplayName(file.name);
      const type = extensionType(displayName);
      if (!type || !allowedMimeTypes[type].has(file.type.toLowerCase())) {
        throw new UploadValidationError("UPLOAD_TYPE_UNSUPPORTED");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== file.size || !hasMagic(type, bytes)) {
        throw new UploadValidationError("UPLOAD_SIGNATURE_INVALID");
      }
      let contentHash: string;
      try {
        contentHash = normalizedContentHash(type, bytes);
      } catch {
        throw new UploadValidationError("UPLOAD_SIGNATURE_INVALID");
      }
      validated.push({ file, displayName, type, bytes, contentHash });
    }

    for (const { file, displayName, type, bytes, contentHash } of validated) {
      /** 查重范围包含 ownerId，不同用户不会共享彼此的私有文档记录。 */
      const existing = await this.store.findByOwnerHash(ownerId, contentHash);
      if (existing?.status === "ready") {
        await this.store.attachToRun(existing.id, runId, ownerId);
        results.push({
          documentId: existing.id,
          status: "ready",
          chunkCount: 0,
          reused: true,
        });
        continue;
      }

      const storageKey =
        existing?.storageKey ?? `documents/${this.createId()}.${type}`;
      let document = existing;
      if (!document) {
        /** 数据库创建失败时删除已经写入的对象，避免产生孤儿文件。 */
        await this.storage.put(storageKey, bytes, file.type);
        try {
          document = await this.store.createPending({
            runId,
            ownerId,
            title: displayName.replace(/\.[^.]+$/u, ""),
            originalName: displayName,
            type,
            mimeType: file.type,
            fileSize: file.size,
            contentHash,
            storageKey,
          });
        } catch (error) {
          await this.storage.delete(storageKey);
          throw error;
        }
        /**
         * 并发上传相同内容时，数据库唯一键只允许一个记录成功。
         * 如果返回记录使用了另一个 storageKey，当前请求创建的对象已经多余。
         */
        if (document.storageKey !== storageKey) {
          await this.storage.delete(storageKey);
        }
      }
      await this.store.attachToRun(document.id, runId, ownerId);
      results.push(await this.ingestor.ingest(ownerId, document.id));
    }
    return results;
  }
}
