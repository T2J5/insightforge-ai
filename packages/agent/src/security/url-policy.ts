import { assertPublicWebUrl, type HostnameResolver } from "../tools/search-web";

export class UrlPolicy {
  constructor(
    private readonly resolver?: HostnameResolver,
    readonly maxRedirects = 5,
  ) {
    if (
      !Number.isInteger(maxRedirects) ||
      maxRedirects < 0 ||
      maxRedirects > 10
    ) {
      throw new Error("URL_MAX_REDIRECTS_INVALID");
    }
  }

  assertAllowed(url: string): Promise<string> {
    return this.resolver
      ? assertPublicWebUrl(url, this.resolver)
      : assertPublicWebUrl(url);
  }

  async assertRedirectAllowed(
    url: string,
    redirectCount: number,
  ): Promise<string> {
    if (redirectCount > this.maxRedirects)
      throw new Error("WEB_REDIRECT_LIMIT_EXCEEDED");
    return this.assertAllowed(url);
  }
}
