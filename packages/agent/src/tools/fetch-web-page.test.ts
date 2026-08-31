import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { BoundedWebPageFetcher, type WebFetch } from "./fetch-web-page";
import type { HostnameResolver } from "./search-web";

const publicResolver: HostnameResolver = async () => [
  { address: "93.184.216.34", family: 4 },
];

const fixedNow = () => new Date("2026-08-28T00:00:00.000Z");

const createFetcher = (
  fetchImplementation: WebFetch,
  overrides: Partial<
    ConstructorParameters<typeof BoundedWebPageFetcher>[0]
  > = {},
) =>
  new BoundedWebPageFetcher({
    fetch: fetchImplementation,
    resolver: publicResolver,
    now: fixedNow,
    ...overrides,
  });

describe("BoundedWebPageFetcher", () => {
  it("fetches, cleans and hashes a public HTML page", async () => {
    const fetchImplementation = vi.fn<WebFetch>(async () =>
      Promise.resolve(
        new Response(
          `<!doctype html>
          <html>
            <head>
              <title>Example &amp; Company</title>
              <style>.hidden { display: none; }</style>
              <script>window.secret = true;</script>
            </head>
            <body>
              <h1>Company profile</h1>
              <p>Public research content.</p>
            </body>
          </html>`,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      ),
    );
    const fetcher = createFetcher(fetchImplementation);

    const result = await fetcher.fetch({
      url: "https://Example.com/report?utm_source=test#section",
    });

    expect(result).toEqual({
      canonicalUrl: "https://example.com/report",
      title: "Example & Company",
      publisher: null,
      publishedAt: null,
      fetchedAt: "2026-08-28T00:00:00.000Z",
      content: "Example & Company Company profile Public research content.",
      contentHash: createHash("sha256")
        .update(
          "Example & Company Company profile Public research content.",
          "utf8",
        )
        .digest("hex"),
      httpStatus: 200,
      contentType: "text/html",
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://example.com/report",
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects a declared response larger than the byte limit", async () => {
    const fetcher = createFetcher(
      async () =>
        new Response("small", {
          headers: {
            "content-type": "text/plain",
            "content-length": "101",
          },
        }),
      { maxResponseBytes: 100 },
    );

    await expect(
      fetcher.fetch({ url: "https://example.com/large" }),
    ).rejects.toThrow("PAGE_TOO_LARGE");
  });

  it("stops streaming when the received bytes exceed the limit", async () => {
    const fetcher = createFetcher(
      async () =>
        new Response("123456", {
          headers: { "content-type": "text/plain" },
        }),
      { maxResponseBytes: 5 },
    );

    await expect(
      fetcher.fetch({ url: "https://example.com/stream" }),
    ).rejects.toThrow("PAGE_TOO_LARGE");
  });

  it("rejects an empty page after content cleaning", async () => {
    const fetcher = createFetcher(async () =>
      Promise.resolve(
        new Response("<script>ignore()</script>", {
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    await expect(
      fetcher.fetch({ url: "https://example.com/empty" }),
    ).rejects.toThrow("PAGE_EMPTY");
  });

  it.each([401, 403, 451])("maps HTTP %s to PAGE_BLOCKED", async (status) => {
    const fetcher = createFetcher(async () =>
      Promise.resolve(new Response(null, { status })),
    );

    await expect(
      fetcher.fetch({ url: "https://example.com/blocked" }),
    ).rejects.toThrow("PAGE_BLOCKED");
  });

  it("rejects unsupported response content types", async () => {
    const fetcher = createFetcher(async () =>
      Promise.resolve(
        new Response("binary", {
          headers: { "content-type": "application/octet-stream" },
        }),
      ),
    );

    await expect(
      fetcher.fetch({ url: "https://example.com/file" }),
    ).rejects.toThrow("PAGE_BLOCKED");
  });

  it("revalidates a relative redirect before following it", async () => {
    const fetchImplementation = vi
      .fn<WebFetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/final" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("Final page", {
          headers: { "content-type": "text/plain" },
        }),
      );
    const fetcher = createFetcher(fetchImplementation);

    const result = await fetcher.fetch({
      url: "https://example.com/start",
    });

    expect(result.canonicalUrl).toBe("https://example.com/final");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("does not follow a redirect to a private target", async () => {
    const fetchImplementation = vi.fn<WebFetch>(async () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/admin" },
        }),
      ),
    );
    const fetcher = createFetcher(fetchImplementation);

    await expect(
      fetcher.fetch({ url: "https://example.com/start" }),
    ).rejects.toThrow("WEB_URL_NOT_PUBLIC");
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("stops after the configured redirect limit", async () => {
    const fetchImplementation = vi.fn<WebFetch>(async (url) =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `${String(url)}/next` },
        }),
      ),
    );
    const fetcher = createFetcher(fetchImplementation, { maxRedirects: 1 });

    await expect(
      fetcher.fetch({ url: "https://example.com/start" }),
    ).rejects.toThrow("PAGE_BLOCKED");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("aborts a request when the operation timeout expires", async () => {
    const fetchImplementation = vi.fn<WebFetch>(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("ABORT_SIGNAL_REQUIRED");
      }

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const fetcher = createFetcher(fetchImplementation, {
      defaultTimeoutMs: 5,
    });

    await expect(
      fetcher.fetch({ url: "https://example.com/slow" }),
    ).rejects.toThrow("PAGE_TIMEOUT");
  });

  it("retries a temporary server failure once and then succeeds", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImplementation = vi
      .fn<WebFetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response("Recovered page", {
          headers: { "content-type": "text/plain" },
        }),
      );
    const fetcher = createFetcher(fetchImplementation, { sleep });

    const result = await fetcher.fetch({
      url: "https://example.com/temporary-failure",
    });

    expect(result.content).toBe("Recovered page");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("does not retry a permanent blocked response", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImplementation = vi.fn<WebFetch>(async () =>
      Promise.resolve(new Response(null, { status: 403 })),
    );
    const fetcher = createFetcher(fetchImplementation, { sleep });

    await expect(
      fetcher.fetch({ url: "https://example.com/private" }),
    ).rejects.toThrow("PAGE_BLOCKED");

    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("maps an exhausted HTTP 429 retry to SEARCH_RATE_LIMITED", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImplementation = vi.fn<WebFetch>(async () =>
      Promise.resolve(new Response(null, { status: 429 })),
    );
    const fetcher = createFetcher(fetchImplementation, { sleep });

    await expect(
      fetcher.fetch({ url: "https://example.com/rate-limited" }),
    ).rejects.toThrow("SEARCH_RATE_LIMITED");

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("holds the hostname concurrency slot until the response body is consumed", async () => {
    let releaseFirstBody: (() => void) | undefined;
    const firstBody = new ReadableStream<Uint8Array>({
      start(controller) {
        releaseFirstBody = () => {
          controller.enqueue(new TextEncoder().encode("First page"));
          controller.close();
        };
      },
    });
    const fetchImplementation = vi
      .fn<WebFetch>()
      .mockResolvedValueOnce(
        new Response(firstBody, {
          headers: { "content-type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("Second page", {
          headers: { "content-type": "text/plain" },
        }),
      );
    const fetcher = createFetcher(fetchImplementation, {
      maxConcurrencyPerHostname: 1,
    });

    const first = fetcher.fetch({ url: "https://example.com/first" });
    await vi.waitFor(() => {
      expect(fetchImplementation).toHaveBeenCalledOnce();
    });

    const second = fetcher.fetch({ url: "https://example.com/second" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fetchImplementation).toHaveBeenCalledOnce();

    releaseFirstBody?.();
    await expect(first).resolves.toEqual(
      expect.objectContaining({ content: "First page" }),
    );
    await expect(second).resolves.toEqual(
      expect.objectContaining({ content: "Second page" }),
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
