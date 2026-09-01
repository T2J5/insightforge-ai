import { describe, expect, it } from "vitest";

import { chunkDocument } from "./chunk";
import {
  DefaultDocumentParser,
  removeRepeatedHeadersAndFooters,
} from "./parsers";

describe("DefaultDocumentParser", () => {
  it("解析 Markdown 标题和正文", async () => {
    const result = await new DefaultDocumentParser().parse({
      type: "markdown",
      displayName: "strategy.md",
      bytes: new TextEncoder().encode("# Strategy\n\n## Market\nGrowth plan"),
    });
    expect(result.title).toBe("Strategy");
    expect(result.pages[0]).toMatchObject({
      pageNumber: 1,
      headings: ["Strategy", "Market"],
    });
    expect(result.pages[0]?.text).toContain("Growth plan");
  });

  it("拒绝空文本", async () => {
    await expect(
      new DefaultDocumentParser().parse({
        type: "text",
        displayName: "empty.txt",
        bytes: new TextEncoder().encode("   "),
      }),
    ).rejects.toThrow("DOCUMENT_EMPTY");
  });

  it("空 PDF 不生成空索引", async () => {
    const objects = [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const object of objects) {
      offsets.push(new TextEncoder().encode(pdf).byteLength);
      pdf += object;
    }
    const xref = new TextEncoder().encode(pdf).byteLength;
    pdf += `xref\n0 3\n0000000000 65535 f \n${offsets[1]!.toString().padStart(10, "0")} 00000 n \n${offsets[2]!.toString().padStart(10, "0")} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    await expect(
      new DefaultDocumentParser().parse({
        type: "pdf",
        displayName: "empty.pdf",
        bytes: new TextEncoder().encode(pdf),
      }),
    ).rejects.toThrow(/DOCUMENT_EMPTY_OR_SCANNED|DOCUMENT_PARSE_FAILED/u);
  });

  it("仅删除至少出现在 60% 页面边界的重复行", () => {
    const pages = [1, 2, 3, 4, 5].map((pageNumber) => ({
      pageNumber,
      headings: [],
      text: `Company Confidential\nPage body ${pageNumber}\nPage ${pageNumber}`,
    }));
    const result = removeRepeatedHeadersAndFooters(pages);
    expect(result.every((page) => !page.text.includes("Confidential"))).toBe(
      true,
    );
    expect(result.map((page) => page.text)).toContain("Page body 1");
  });
});

describe("chunkDocument", () => {
  it("按页分块并保留页码和标题路径", () => {
    const chunks = chunkDocument(
      {
        title: "Test",
        pages: [{ pageNumber: 2, headings: ["Market"], text: "a".repeat(200) }],
      },
      { targetTokens: 20, maxTokens: 30, overlapTokens: 5 },
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.metadata).toEqual({
      pageStart: 2,
      pageEnd: 2,
      headingPath: ["Market"],
    });
    expect(chunks.every((chunk) => chunk.tokenCount <= 30)).toBe(true);
  });
});
