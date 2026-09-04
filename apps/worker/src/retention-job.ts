const GUEST_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface ExpiredGuestDocument {
  id: string;
  storageKey: string;
  referencedByEvidence: boolean;
}

export interface RetentionRepository {
  listExpiredGuestDocuments(input: {
    createdBefore: Date;
    limit: number;
  }): Promise<ExpiredGuestDocument[]>;
  deleteChunks(documentId: string): Promise<void>;
  deleteDocument(documentId: string): Promise<void>;
}

export interface RetentionObjectStorage {
  delete(storageKey: string): Promise<void>;
}

export class GuestUploadRetentionJob {
  constructor(
    private readonly repository: RetentionRepository,
    private readonly storage: RetentionObjectStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(limit = 100): Promise<{ deleted: number; preserved: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("RETENTION_BATCH_LIMIT_INVALID");
    }
    const documents = await this.repository.listExpiredGuestDocuments({
      createdBefore: new Date(this.now().getTime() - GUEST_UPLOAD_RETENTION_MS),
      limit,
    });
    let deleted = 0;
    let preserved = 0;
    for (const document of documents) {
      // 报告仍引用的证据片段必须保留，避免已发布报告失去依据。
      if (document.referencedByEvidence) {
        preserved += 1;
        continue;
      }
      await this.repository.deleteChunks(document.id);
      await this.storage.delete(document.storageKey);
      await this.repository.deleteDocument(document.id);
      deleted += 1;
    }
    return { deleted, preserved };
  }
}
