import { describe, expect, it } from "vitest";
import { UrlPolicy } from "./url-policy";

describe("UrlPolicy", () => {
  const publicResolver = async () => [
    { address: "93.184.216.34", family: 4 as const },
  ];

  it.each([
    "file:///etc/passwd",
    "http://user:pass@example.com",
    "http://127.0.0.1/admin",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(
      new UrlPolicy(publicResolver).assertAllowed(url),
    ).rejects.toThrow();
  });

  it("rechecks redirect targets and enforces the redirect cap", async () => {
    const policy = new UrlPolicy(publicResolver, 1);
    await expect(
      policy.assertRedirectAllowed("https://example.com/next", 1),
    ).resolves.toBe("https://example.com/next");
    await expect(
      policy.assertRedirectAllowed("https://example.com/next", 2),
    ).rejects.toThrow("WEB_REDIRECT_LIMIT_EXCEEDED");
  });
});
