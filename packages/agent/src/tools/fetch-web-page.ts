import { assertPublicWebUrl, type HostnameResolver } from "./search-web";
import {
  defaultSleep,
  HostnameConcurrencyLimiter,
  RetryableWebError,
  retryWebOperation,
  type Sleep,
} from "./web-resilience";
import {
  FetchedPageSchema,
  FetchWebPageInputSchema,
  type FetchedPage,
  type FetchWebPageInput,
  type WebPagePort,
} from "@insightforge/domain";
import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

const ALLOWED_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
]);

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_CONCURRENCY_PER_HOSTNAME = 2;

const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

type FetchAttemptResult =
  | {
      kind: "redirect";
      targetUrl: string;
    }
  | {
      kind: "page";
      page: FetchedPage;
    };

export type WebFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchWebPageOptions {
  fetch?: WebFetch;
  resolver?: HostnameResolver;
  now?: () => Date;
  defaultTimeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;

  maxAttempts?: number;
  retryDelayMs?: number;
  maxConcurrencyPerHostname?: number;
  sleep?: Sleep;
}

const assertPositiveInteger = (value: number, errorCode: string): void => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(errorCode);
  }
};

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/gu, " ").trim();

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([\da-f]+);/giu, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
const extractHtmlTitle = (html: string): string | null => {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html);

  if (!match?.[1]) {
    return null;
  }
  const title = normalizeWhitespace(
    decodeHtmlEntities(match[1].replace(/<[^>]+>/gu, " ")),
  );
  return title.length > 0 ? title.slice(0, 500) : null;
};

/**
 * 当前阶段使用确定性基础清洗。
 *
 * 后续如果需要更完整的 HTML 解析，可以替换为专门的
 * HTML Parser，但对外仍保持 WebPagePort 不变。
 */
const extractTextContent = (
  rawContent: string,
  contentType: string,
): string => {
  if (contentType === "text/plain") return normalizeWhitespace(rawContent);

  const withoutNonContentElements = rawContent
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(
      /<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/giu,
      " ",
    );
  const text = withoutNonContentElements
    .replace(
      /<\/?(?:p|div|section|article|main|header|footer|nav|aside|h[1-6]|li|ul|ol|table|tr|td|th|br)\b[^>]*>/giu,
      "\n",
    )
    .replace(/<[^>]+>/gu, " ");
  return normalizeWhitespace(decodeHtmlEntities(text));
};

const getContentType = (response: Response): string => {
  const header = response.headers.get("content-type");
  if (!header) throw new Error("PAGE_BLOCKED");
  return header.split(";", 1)[0]?.trim().toLocaleLowerCase() ?? "";
};

const readBoundedResponseBody = async (
  response: Response,
  maxResponseBytes: number,
): Promise<string> => {
  const declaredLength = response.headers.get("content-length");

  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxResponseBytes) {
      throw new Error("PAGE_TOO_LARGE");
    }
  }
  if (!response.body) throw new Error("PAGE_EMPTY");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel();
        throw new Error("PAGE_TOO_LARGE");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) throw new Error("PAGE_EMPTY");
  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", {
    fatal: false,
  }).decode(body);
};

const getRedirectTarget = (response: Response, currentUrl: string): string => {
  const location = response.headers.get("location");
  if (!location) throw new Error("PAGE_BLOCKED");

  try {
    return new URL(location, currentUrl).toString();
  } catch {
    throw new Error("PAGE_BLOCKED");
  }
};

export class BoundedWebPageFetcher implements WebPagePort {
  private readonly fetchImplementation: WebFetch;
  private readonly resolver: HostnameResolver | undefined;
  private readonly now: () => Date;
  private readonly defaultTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: Sleep;
  private readonly concurrencyLimiter: HostnameConcurrencyLimiter;

  constructor(options: FetchWebPageOptions = {}) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.resolver = options.resolver;
    this.now = options.now ?? (() => new Date());
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.concurrencyLimiter = new HostnameConcurrencyLimiter(
      options?.maxConcurrencyPerHostname ??
        DEFAULT_MAX_CONCURRENCY_PER_HOSTNAME,
    );
    assertPositiveInteger(this.defaultTimeoutMs, "PAGE_TIMEOUT_INVALID");
    assertPositiveInteger(this.maxResponseBytes, "PAGE_MAX_SIZE_INVALID");
    assertPositiveInteger(this.maxRedirects, "PAGE_MAX_REDIRECTS_INVALID");
    assertPositiveInteger(this.maxAttempts, "WEB_MAX_ATTEMPTS_INVALID");
    assertPositiveInteger(this.retryDelayMs, "WEB_RETRY_DELAY_INVALID");
  }

  async fetch(untrustedInput: FetchWebPageInput): Promise<FetchedPage> {
    const input = FetchWebPageInputSchema.parse(untrustedInput);
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;

    assertPositiveInteger(timeoutMs, "PAGE_TIMEOUT_INVALID");

    const operationDeadline = Date.now() + timeoutMs;
    return retryWebOperation(
      async () => this.fetchFollowingRedirects(input.url, 0, operationDeadline),
      {
        maxAttempts: this.maxAttempts,
        retryDelayMs: this.retryDelayMs,
        deadlineAt: operationDeadline,
        sleep: this.sleep,
      },
    );
  }

  private async fetchFollowingRedirects(
    untrustedUrl: string,
    redirectCount: number,
    operationDeadline: number,
  ): Promise<FetchedPage> {
    if (redirectCount > this.maxRedirects) {
      throw new Error("PAGE_BLOCKED");
    }

    const canonicalUrl =
      this.resolver === undefined
        ? await assertPublicWebUrl(untrustedUrl)
        : await assertPublicWebUrl(untrustedUrl, this.resolver);

    const remainingTimeoutMs = operationDeadline - Date.now();
    if (remainingTimeoutMs <= 0) throw new Error("PAGE_TIMEOUT");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), remainingTimeoutMs);

    try {
      const hostname = new URL(canonicalUrl).hostname;

      const result = await this.concurrencyLimiter.run<FetchAttemptResult>(
        hostname,
        async () => {
          let response: Response;
          try {
            response = await this.fetchImplementation(canonicalUrl, {
              method: "GET",
              redirect: "manual",
              signal: controller.signal,
              headers: {
                accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
                "user-agent": "InsightForgeBot/0.1 (+public research agent)",
              },
            });
          } catch (error) {
            if (controller.signal.aborted) {
              throw new Error("PAGE_TIMEOUT", { cause: error });
            }
            throw new RetryableWebError("PAGE_BLOCKED", { cause: error });
          }

          if (REDIRECT_STATUS_CODES.has(response.status)) {
            return {
              kind: "redirect",
              targetUrl: getRedirectTarget(response, canonicalUrl),
            };
          }

          if (RETRYABLE_HTTP_STATUS_CODES.has(response.status)) {
            throw new RetryableWebError(
              response.status === 429 ? "SEARCH_RATE_LIMITED" : "PAGE_BLOCKED",
            );
          }

          if (
            response.status === 401 ||
            response.status === 403 ||
            response.status === 451
          ) {
            throw new Error("PAGE_BLOCKED");
          }
          if (!response.ok) {
            throw new Error("PAGE_BLOCKED");
          }

          const contentType = getContentType(response);
          if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
            throw new Error("PAGE_BLOCKED");
          }

          const rawContent = await readBoundedResponseBody(
            response,
            this.maxResponseBytes,
          );
          const content = extractTextContent(rawContent, contentType);

          if (content.length === 0) throw new Error("PAGE_EMPTY");

          const title =
            extractHtmlTitle(rawContent) ?? new URL(canonicalUrl).hostname;
          const contentHash = createHash("sha256")
            .update(content)
            .digest("hex");

          return {
            kind: "page",
            page: FetchedPageSchema.parse({
              canonicalUrl,
              title,
              content,
              contentHash,
              publisher: null,
              publishedAt: null,
              fetchedAt: this.now().toISOString(),
              httpStatus: response.status,
              contentType,
            }),
          };
        },
      );

      if (result.kind === "redirect") {
        return this.fetchFollowingRedirects(
          result.targetUrl,
          redirectCount + 1,
          operationDeadline,
        );
      }
      return result.page;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("PAGE_TIMEOUT", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
