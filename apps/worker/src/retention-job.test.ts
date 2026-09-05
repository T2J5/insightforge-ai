import { describe, expect, it, vi } from "vitest";
import { GuestUploadRetentionJob } from "./retention-job";

describe("GuestUploadRetentionJob", () => {
  it("deletes expired unreferenced uploads and preserves report evidence", async () => {
    const repository = {
      listExpiredGuestDocuments: vi.fn().mockResolvedValue([
        {
          id: "delete",
          storageKey: "guest/delete",
          referencedByEvidence: false,
        },
        { id: "keep", storageKey: "guest/keep", referencedByEvidence: true },
      ]),
      deleteChunks: vi.fn(),
      deleteDocument: vi.fn(),
    };
    const storage = { delete: vi.fn() };
    const result = await new GuestUploadRetentionJob(
      repository,
      storage,
      () => new Date("2026-09-04T12:00:00.000Z"),
    ).run();
    expect(repository.listExpiredGuestDocuments).toHaveBeenCalledWith({
      createdBefore: new Date("2026-09-03T12:00:00.000Z"),
      limit: 100,
    });
    expect(repository.deleteChunks).toHaveBeenCalledWith("delete");
    expect(storage.delete).toHaveBeenCalledWith("guest/delete");
    expect(repository.deleteDocument).toHaveBeenCalledWith("delete");
    expect(repository.deleteDocument).not.toHaveBeenCalledWith("keep");
    expect(result).toEqual({ deleted: 1, preserved: 1 });
  });
});
