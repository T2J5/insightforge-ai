import { createHash } from "node:crypto";
import type {
  FetchedPage,
  FetchWebPageInput,
  RetrievedChunk,
  WebPagePort,
} from "@insightforge/domain";
import type { UploadedDocumentRetriever } from "./tools/search-uploaded-documents";
import type {
  WebSearchHit,
  WebSearchInput,
  WebSearchPort,
} from "./tools/web-search";

export type ResearchCacheScope =
  | {
      kind: "public-search";
      query: string;
      providerVersion: string;
    }
  | {
      kind: "public-page";
      canonicalUrl: string;
      providerVersion: string;
    }
  | {
      kind: "public-report";
      reportId: string;
      version: number;
      containsPrivateDocuments: boolean;
    }
  | {
      kind: "private-retrieval";
      ownerId: string;
      documentIds: readonly string[];
      query: string;
      indexVersion: string;
      rerankerVersion: string;
    };

export interface ResearchCacheStore {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expirationMode: "EX",
    ttlSeconds: number,
  ): Promise<unknown>;
}

const hash = (value: string): string =>
  createHash("sha256").update(value.trim().toLowerCase()).digest("hex");

export class ResearchCache {
  constructor(private readonly store: ResearchCacheStore) {}

  key(scope: ResearchCacheScope): string {
    if (scope.kind === "public-search") {
      return `research-cache:public:search:${scope.providerVersion}:${hash(scope.query)}`;
    }
    if (scope.kind === "public-page") {
      return `research-cache:public:page:${scope.providerVersion}:${hash(scope.canonicalUrl)}`;
    }
    if (scope.kind === "public-report") {
      if (scope.containsPrivateDocuments) {
        throw new Error("PRIVATE_REPORT_CACHE_FORBIDDEN");
      }
      return `research-cache:public:report:${scope.reportId}:v${scope.version}`;
    }
    const documents = [...new Set(scope.documentIds)].sort().join(",");
    return [
      "research-cache:private",
      hash(scope.ownerId),
      scope.indexVersion,
      scope.rerankerVersion,
      hash(documents),
      hash(scope.query),
    ].join(":");
  }

  async get<T>(scope: ResearchCacheScope): Promise<T | null> {
    const value = await this.store.get(this.key(scope));
    if (value === null) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async set<T>(
    scope: ResearchCacheScope,
    value: T,
    ttlSeconds: number,
  ): Promise<void> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1)
      throw new Error("CACHE_TTL_INVALID");
    if (scope.kind === "public-report" && ttlSeconds > 7 * 24 * 60 * 60) {
      throw new Error("PUBLIC_REPORT_CACHE_TTL_EXCEEDED");
    }
    await this.store.set(
      this.key(scope),
      JSON.stringify(value),
      "EX",
      ttlSeconds,
    );
  }
}

export class CachedWebSearch implements WebSearchPort {
  constructor(
    private readonly inner: WebSearchPort,
    private readonly cache: ResearchCache,
    private readonly providerVersion: string,
    private readonly ttlSeconds = 3_600,
  ) {}

  async search(input: WebSearchInput): Promise<WebSearchHit[]> {
    const scope = {
      kind: "public-search" as const,
      query: `${input.searchDepth}:${input.query}`,
      providerVersion: this.providerVersion,
    };
    const cached = await this.cache.get<WebSearchHit[]>(scope);
    if (cached) return cached.slice(0, input.maxResults);
    // 缓存供应商允许的最大结果集，避免 maxResults 进入缓存键造成重复条目。
    const results = await this.inner.search({ ...input, maxResults: 10 });
    await this.cache.set(scope, results, this.ttlSeconds);
    return results.slice(0, input.maxResults);
  }
}

export class CachedWebPage implements WebPagePort {
  constructor(
    private readonly inner: WebPagePort,
    private readonly cache: ResearchCache,
    private readonly providerVersion: string,
    private readonly ttlSeconds = 7 * 24 * 60 * 60,
  ) {}

  async fetch(input: FetchWebPageInput): Promise<FetchedPage> {
    const scope = {
      kind: "public-page" as const,
      canonicalUrl: input.url,
      providerVersion: this.providerVersion,
    };
    const cached = await this.cache.get<FetchedPage>(scope);
    if (cached) return cached;
    const page = await this.inner.fetch(input);
    await this.cache.set(scope, page, this.ttlSeconds);
    return page;
  }
}

export class CachedUploadedDocumentRetriever implements UploadedDocumentRetriever {
  constructor(
    private readonly inner: UploadedDocumentRetriever,
    private readonly cache: ResearchCache,
    private readonly indexVersion: string,
    private readonly rerankerVersion: string,
    private readonly ttlSeconds = 900,
  ) {}

  async search(input: {
    ownerId: string;
    query: string;
    documentIds: string[];
    limit: number;
  }): Promise<RetrievedChunk[]> {
    const scope = {
      kind: "private-retrieval" as const,
      ownerId: input.ownerId,
      query: input.query,
      documentIds: input.documentIds,
      indexVersion: this.indexVersion,
      rerankerVersion: this.rerankerVersion,
    };
    const cached = await this.cache.get<RetrievedChunk[]>(scope);
    if (cached) return cached.slice(0, input.limit);
    const results = await this.inner.search({ ...input, limit: 20 });
    await this.cache.set(scope, results, this.ttlSeconds);
    return results.slice(0, input.limit);
  }
}
