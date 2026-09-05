const GUEST_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface ExpiredGuestDocument {
  id: string;
  storageKey: string;
  referencedByEvidence: boolean;
}

export interface RetentionRepository {
  /**
   * “过期且属于访客”的筛选逻辑由 Repository/SQL 负责；Job 只编排批次。
   * referencedByEvidence 也应由数据库关联查询得出，不能由客户端声明。
   */
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
    // 按批次串行处理，便于限制对象存储和数据库压力。某条删除失败时立即抛出，
    // 调度器可在下一轮重试；因此各 delete 实现本身应当具备幂等性。
    for (const document of documents) {
      // 报告仍引用的证据片段必须保留，避免已发布报告失去依据。
      if (document.referencedByEvidence) {
        preserved += 1;
        continue;
      }
      /**
       * 删除顺序体现引用关系：先删子表 chunks，再删对象，最后删 document。
       * 如果对象存储删除失败，document 记录仍在，下一次任务仍能找到 storageKey
       * 继续重试；若先删数据库记录，对象可能成为无法定位的孤儿文件。
       * 用量事件位于独立表，不在该清理流程中，历史成本审计因此得以保留。
       */
      await this.repository.deleteChunks(document.id);
      await this.storage.delete(document.storageKey);
      await this.repository.deleteDocument(document.id);
      deleted += 1;
    }
    return { deleted, preserved };
  }
}
