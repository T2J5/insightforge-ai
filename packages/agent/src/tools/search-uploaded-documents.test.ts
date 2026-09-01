import { describe, expect, it, vi } from "vitest";
import { SearchUploadedDocumentsTool } from "./search-uploaded-documents";

describe("SearchUploadedDocumentsTool", () => {
  it("ownerId 只来自服务端上下文", async () => {
    const search = vi.fn(async () => []);
    const tool = new SearchUploadedDocumentsTool({ search });
    await tool.execute(
      { ownerId: "user-a" },
      { query: "strategy", documentIds: [], limit: 8 },
    );
    expect(search).toHaveBeenCalledWith({
      ownerId: "user-a",
      query: "strategy",
      documentIds: [],
      limit: 8,
    });
  });

  it("拒绝模型在参数中伪造 ownerId", async () => {
    const tool = new SearchUploadedDocumentsTool({
      search: vi.fn(async () => []),
    });
    await expect(
      tool.execute(
        { ownerId: "user-a" },
        { ownerId: "user-b", query: "private strategy" },
      ),
    ).rejects.toThrow();
  });
});
