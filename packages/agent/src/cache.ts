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

/**
 * 集中生成缓存键，最重要的目标不是缩短代码，而是隔离数据作用域：
 * public 数据可以跨用户复用，private 数据必须绑定 ownerId 和文档集合。
 * provider/index/reranker 的版本进入键中，使实现或索引升级后自然绕过旧缓存，
 * 不需要扫描 Redis 批量删除未知格式的数据。
 */
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
      // 这是运行时的第二道防线：即便调用方误选 public-report 作用域，
      // 含私有上传文档的报告也不能写入可跨用户共享的命名空间。
      if (scope.containsPrivateDocuments) {
        throw new Error("PRIVATE_REPORT_CACHE_FORBIDDEN");
      }
      return `research-cache:public:report:${scope.reportId}:v${scope.version}`;
    }
    // documentIds 在语义上是集合。去重并排序后，[A,B] 与 [B,A] 命中同一键，
    // 同时 ownerId 的哈希确保不同所有者不会共享私有检索结果。
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
      // 泛型 T 只方便调用方表达期望类型，并不会在运行时验证 JSON。
      // 缓存值仍应被视为外部数据；安全关键结构应在使用处再经过 Zod 校验。
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
      // 给公开报告设置硬上限，防止旧版本长期存活并增加删除/纠错成本。
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
    // 缓存供应商允许的最大结果集，再按本次请求切片。
    // 因而 maxResults 不需要进入缓存键，1/5/10 条请求可以共享一个缓存项。
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
    // 与网页搜索相同：缓存统一的较大候选集，再按 limit 切片，减少键数量。
    // 私有检索默认只缓存 15 分钟，缩短文档删除或索引变化后的残留时间。
    const results = await this.inner.search({ ...input, limit: 20 });
    await this.cache.set(scope, results, this.ttlSeconds);
    return results.slice(0, input.limit);
  }
}
