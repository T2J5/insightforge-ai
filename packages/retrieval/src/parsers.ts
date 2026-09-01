import mammoth from "mammoth";

import {
  ParsedDocumentSchema,
  SupportedDocumentTypeSchema,
  type ParsedDocument,
  type SupportedDocumentType,
} from "@insightforge/domain";

export interface ParseDocumentInput {
  type: SupportedDocumentType;
  displayName: string;
  bytes: Uint8Array;
}

export interface DocumentParser {
  parse(input: ParseDocumentInput): Promise<ParsedDocument>;
}

const normalizeText = (value: string): string =>
  value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v]+/gu, " ")
    .replace(/[ ]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

const fallbackTitle = (displayName: string): string => {
  const withoutExtension = displayName.replace(/\.[^.]+$/u, "").trim();
  return (withoutExtension || "Untitled document").slice(0, 500);
};

const extractMarkdownPage = (
  text: string,
  pageNumber: number,
): ParsedDocument["pages"][number] => {
  const headingPath: string[] = [];
  const body: string[] = [];

  for (const rawLine of normalizeText(text).split("\n")) {
    const heading = /^(#{1,6})\s+(.+)$/u.exec(rawLine.trim());
    if (!heading) {
      body.push(rawLine);
      continue;
    }
    const level = heading[1]!.length;
    const title = heading[2]!.trim().slice(0, 500);
    headingPath.splice(level - 1);
    headingPath[level - 1] = title;
    body.push(title);
  }

  return {
    pageNumber,
    headings: headingPath.filter(Boolean),
    text: normalizeText(body.join("\n")),
  };
};

const normalizeRepeatedLine = (value: string): string =>
  value.toLowerCase().replace(/\d+/gu, "#").replace(/\s+/gu, " ").trim();

/**
 * 只检查每页首行和尾行，且至少出现在 60% 页面中才删除。
 * 这避免把正文中偶然重复的公司名称或章节标题误删。
 */
export const removeRepeatedHeadersAndFooters = (
  pages: ParsedDocument["pages"],
): ParsedDocument["pages"] => {
  if (pages.length < 2) return pages;
  const frequency = new Map<string, Set<number>>();

  for (const page of pages) {
    const lines = page.text
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const boundary = [lines[0], lines.at(-1)].filter(
      (line): line is string => line !== undefined,
    );
    for (const line of new Set(boundary.map(normalizeRepeatedLine))) {
      if (line.length === 0) continue;
      const seenPages = frequency.get(line) ?? new Set<number>();
      seenPages.add(page.pageNumber);
      frequency.set(line, seenPages);
    }
  }

  const threshold = Math.ceil(pages.length * 0.6);
  const repeated = new Set(
    [...frequency.entries()]
      .filter(([, pageNumbers]) => pageNumbers.size >= threshold)
      .map(([line]) => line),
  );

  return pages.flatMap((page) => {
    const cleaned = normalizeText(
      page.text
        .split("\n")
        .filter((line) => !repeated.has(normalizeRepeatedLine(line)))
        .join("\n"),
    );
    return cleaned.length === 0 ? [] : [{ ...page, text: cleaned }];
  });
};

const parsePlainText = (input: ParseDocumentInput): ParsedDocument => {
  const text = normalizeText(
    new TextDecoder("utf-8", { fatal: true }).decode(input.bytes),
  );
  if (text.length === 0) throw new Error("DOCUMENT_EMPTY");
  const page = extractMarkdownPage(text, 1);
  return ParsedDocumentSchema.parse({
    title: page.headings[0] ?? fallbackTitle(input.displayName),
    pages: [page],
  });
};

const htmlEntityDecode = (value: string): string =>
  value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");

const parseDocx = async (
  input: ParseDocumentInput,
): Promise<ParsedDocument> => {
  const result = await mammoth.convertToHtml({
    buffer: Buffer.from(input.bytes),
  });
  const markdownLike = htmlEntityDecode(result.value)
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/giu,
      (_all, level: string, value: string) =>
        `${"#".repeat(Number(level))} ${value.replace(/<[^>]+>/gu, " ")}\n`,
    )
    .replace(/<\/(?:p|li|tr)>/giu, "\n")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, " ");
  const parsed = parsePlainText({
    ...input,
    bytes: new TextEncoder().encode(markdownLike),
  });
  return ParsedDocumentSchema.parse(parsed);
};

const parsePdf = async (input: ParseDocumentInput): Promise<ParsedDocument> => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: input.bytes.slice() });
  const pdf = await loadingTask.promise;
  const pages: ParsedDocument["pages"] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = normalizeText(
        textContent.items
          .flatMap((item) => ("str" in item ? [item.str] : []))
          .join(" "),
      );
      if (text.length > 0) {
        pages.push({ pageNumber, headings: [], text });
      }
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  const cleanedPages = removeRepeatedHeadersAndFooters(pages);
  if (cleanedPages.length === 0) throw new Error("DOCUMENT_EMPTY_OR_SCANNED");
  return ParsedDocumentSchema.parse({
    title: fallbackTitle(input.displayName),
    pages: cleanedPages,
  });
};

export class DefaultDocumentParser implements DocumentParser {
  async parse(untrustedInput: ParseDocumentInput): Promise<ParsedDocument> {
    const type = SupportedDocumentTypeSchema.parse(untrustedInput.type);
    const input = { ...untrustedInput, type };
    try {
      if (type === "pdf") return await parsePdf(input);
      if (type === "docx") return await parseDocx(input);
      return parsePlainText(input);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("DOCUMENT_")) {
        throw error;
      }
      throw new Error("DOCUMENT_PARSE_FAILED", { cause: error });
    }
  }
}
