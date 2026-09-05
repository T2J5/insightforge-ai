import { describe, expect, it, vi } from "vitest";
import { ResearchCache } from "./cache";

describe("ResearchCache", () => {
  const cache = new ResearchCache({ get: vi.fn(), set: vi.fn() });

  it("isolates private retrieval by owner", () => {
    const base = {
      kind: "private-retrieval" as const,
      documentIds: ["b", "a"],
      query: "strategy",
      indexVersion: "i1",
      rerankerVersion: "r1",
    };
    expect(cache.key({ ...base, ownerId: "user-a" })).not.toBe(
      cache.key({ ...base, ownerId: "user-b" }),
    );
  });

  it("normalizes document order and keeps public keys owner-free", () => {
    const privateKeyA = cache.key({
      kind: "private-retrieval",
      ownerId: "user-a",
      documentIds: ["b", "a"],
      query: "Q",
      indexVersion: "i1",
      rerankerVersion: "r1",
    });
    const privateKeyB = cache.key({
      kind: "private-retrieval",
      ownerId: "user-a",
      documentIds: ["a", "b"],
      query: "q",
      indexVersion: "i1",
      rerankerVersion: "r1",
    });
    expect(privateKeyA).toBe(privateKeyB);
    expect(
      cache.key({ kind: "public-search", query: "q", providerVersion: "v1" }),
    ).not.toContain("user-a");
  });

  it("never caches reports containing private document evidence", () => {
    expect(() =>
      cache.key({
        kind: "public-report",
        reportId: "report-1",
        version: 1,
        containsPrivateDocuments: true,
      }),
    ).toThrow("PRIVATE_REPORT_CACHE_FORBIDDEN");
  });
});
