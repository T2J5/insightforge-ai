import {
  DocumentChunkMetadataSchema,
  type ParsedDocument,
} from "@insightforge/domain";

export interface DocumentChunkDraft {
  chunkIndex: number;
  content: string;
  tokenCount: number;
  metadata: ReturnType<typeof DocumentChunkMetadataSchema.parse>;
}

export interface ChunkDocumentOptions {
  targetTokens?: number;
  maxTokens?: number;
  overlapTokens?: number;
}

/**
 * 不绑定具体 tokenizer 的保守估算：中英文混合文本约四个 UTF-16 字符一个 Token。
 * 真正调用 Embedding 时仍以供应商返回的 usage 为准。
 */
export const estimateTokenCount = (text: string): number =>
  Math.max(1, Math.ceil(text.length / 4));

const splitText = (
  text: string,
  targetCharacters: number,
  maxCharacters: number,
  overlapCharacters: number,
): string[] => {
  const result: string[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = Math.min(start + maxCharacters, text.length);
    let end = Math.min(start + targetCharacters, hardEnd);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf("\n", end),
        text.lastIndexOf("。", end),
        text.lastIndexOf(". ", end),
      );
      if (boundary > start + Math.floor(targetCharacters * 0.6)) {
        end = boundary + 1;
      }
    }
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) result.push(chunk);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlapCharacters);
  }
  return result;
};

export const chunkDocument = (
  document: ParsedDocument,
  options: ChunkDocumentOptions = {},
): DocumentChunkDraft[] => {
  const targetTokens = options.targetTokens ?? 800;
  const maxTokens = options.maxTokens ?? 1_200;
  const overlapTokens = options.overlapTokens ?? 120;
  if (
    targetTokens < 1 ||
    maxTokens < targetTokens ||
    overlapTokens < 0 ||
    overlapTokens >= targetTokens
  ) {
    throw new Error("DOCUMENT_CHUNK_OPTIONS_INVALID");
  }

  const drafts: DocumentChunkDraft[] = [];
  for (const page of document.pages) {
    const pieces = splitText(
      page.text,
      targetTokens * 4,
      maxTokens * 4,
      overlapTokens * 4,
    );
    for (const content of pieces) {
      drafts.push({
        chunkIndex: drafts.length,
        content,
        tokenCount: estimateTokenCount(content),
        metadata: DocumentChunkMetadataSchema.parse({
          pageStart: page.pageNumber,
          pageEnd: page.pageNumber,
          headingPath: page.headings,
        }),
      });
    }
  }
  if (drafts.length === 0) throw new Error("DOCUMENT_EMPTY");
  return drafts;
};
