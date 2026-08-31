import { describe, expect, it } from "vitest";

import {
  assertPublicWebUrl,
  canonicalizeWebUrl,
  deduplicateSearchHits,
  type HostnameResolver,
} from "./search-web";

describe("canonicalizeWebUrl", () => {
  it("normalizes equivalent URLs to one stable canonical URL", () => {
    expect(
      canonicalizeWebUrl(
        "HTTPS://Example.COM:443/company/?utm_source=newsletter&utm_medium=email#team",
      ),
    ).toBe("https://example.com/company");
  });

  it("preserves meaningful query parameters in deterministic order", () => {
    expect(
      canonicalizeWebUrl(
        "https://example.com/search?utm_campaign=test&b=2&a=1",
      ),
    ).toBe("https://example.com/search?a=1&b=2");
  });
});

describe("deduplicateSearchHits", () => {
  it("deduplicates canonical URLs while preserving the first ranked hit", () => {
    const result = deduplicateSearchHits([
      {
        title: "Company profile",
        url: "https://Example.com/company/?utm_source=search#overview",
        snippet: "First result",
        score: 0.95,
        publishedAt: null,
      },
      {
        title: "Duplicate company profile",
        url: "https://example.com/company",
        snippet: "Duplicate result",
        score: 0.8,
        publishedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        title: "Company newsroom",
        url: "https://example.com/newsroom",
        snippet: "Another source",
        score: 0.7,
        publishedAt: null,
      },
    ]);

    expect(result).toEqual([
      {
        title: "Company profile",
        url: "https://Example.com/company/?utm_source=search#overview",
        canonicalUrl: "https://example.com/company",
        snippet: "First result",
        score: 0.95,
        publishedAt: null,
      },
      {
        title: "Company newsroom",
        url: "https://example.com/newsroom",
        canonicalUrl: "https://example.com/newsroom",
        snippet: "Another source",
        score: 0.7,
        publishedAt: null,
      },
    ]);
  });
});

describe("assertPublicWebUrl", () => {
  it.each([
    "file:///etc/passwd",
    "ftp://example.com/file.txt",
    "http://localhost/admin",
    "http://127.0.0.1/admin",
    "http://[::1]/admin",
    "http://10.0.0.1/admin",
    "http://172.16.0.1/admin",
    "http://192.168.1.1/admin",
    "http://169.254.169.254/latest/meta-data",
  ])("rejects a non-public target: %s", async (url) => {
    await expect(assertPublicWebUrl(url)).rejects.toThrow("WEB_URL_NOT_PUBLIC");
  });

  it("rejects a public hostname when DNS resolves it to a private address", async () => {
    const resolver: HostnameResolver = async () => [
      { address: "10.20.30.40", family: 4 },
    ];

    await expect(
      assertPublicWebUrl("https://public-looking.example/report", resolver),
    ).rejects.toThrow("WEB_URL_NOT_PUBLIC");
  });

  it("accepts HTTP(S) URLs only when every resolved address is public", async () => {
    const resolver: HostnameResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ];

    await expect(
      assertPublicWebUrl("https://example.com/report", resolver),
    ).resolves.toBe("https://example.com/report");
  });
});
