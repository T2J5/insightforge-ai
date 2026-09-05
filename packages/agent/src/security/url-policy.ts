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
    // 复用 search-web 中的统一 SSRF 校验：协议、主机名及 DNS 解析后的 IP
    // 都必须允许。只检查 URL 字符串不足以阻止域名解析到内网地址。
    return this.resolver
      ? assertPublicWebUrl(url, this.resolver)
      : assertPublicWebUrl(url);
  }

  async assertRedirectAllowed(
    url: string,
    redirectCount: number,
  ): Promise<string> {
    // 每一次重定向都重新执行完整校验，不能因为初始 URL 合法就信任 Location；
    // 否则公开站点可通过 302 把请求引向 127.0.0.1 或云元数据地址。
    if (redirectCount > this.maxRedirects)
      throw new Error("WEB_REDIRECT_LIMIT_EXCEEDED");
    return this.assertAllowed(url);
  }
}
