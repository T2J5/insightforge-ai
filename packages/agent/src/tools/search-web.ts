import { SearchHitSchema, type SearchHit } from "@insightforge/domain";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * DNS 解析结果。
 *
 * 使用项目自己的最小接口，测试时可以注入 Fake，
 * 避免单元测试访问真实 DNS。
 */
export interface ResolvedHostnameAddress {
  address: string;
  family: 4 | 6;
}

export type HostnameResolver = (
  hostname: string,
) => Promise<readonly ResolvedHostnameAddress[]>;
/**
 * 规范化之前允许 canonicalUrl 不存在。
 *
 * 搜索供应商只负责返回原始 URL；
 * canonicalUrl 必须由项目自己的代码生成。
 */
export type UncanonicalizedSearchHit = Omit<SearchHit, "canonicalUrl"> & {
  canonicalUrl?: string;
};

/**
 * 常见的 URL 跟踪参数名称集合。
 */
const TRACKING_PARAMETER_NAMES = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref_src",
]);

const isTrackingParameter = (name: string): boolean => {
  const normalizedName = name.toLowerCase();
  return (
    normalizedName.startsWith("utm_") ||
    TRACKING_PARAMETER_NAMES.has(normalizedName)
  );
};
const parseHttpUrl = (untrustedUrl: string): URL => {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(untrustedUrl);
  } catch {
    throw new Error("WEB_URL_INVALID");
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("WEB_URL_NOT_PUBLIC");
  }

  /**
   * URL 中不允许携带 Basic Auth 等身份信息。
   *
   * 否则日志、事件和证据引用可能意外泄露凭据。
   */
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    throw new Error("WEB_URL_NOT_PUBLIC");
  }

  return parsedUrl;
};

/**
 * 把等价 URL 转换成稳定形式。
 *
 * 该函数只做语法规范化，不访问 DNS。
 * SSRF 检查由 assertPublicWebUrl 负责。
 */
export const canonicalizeWebUrl = (untrustedUrl: string): string => {
  const parsedUrl = parseHttpUrl(untrustedUrl);

  parsedUrl.hash = "";

  const parameterNames = [
    ...new Set(Array.from(parsedUrl.searchParams.keys())),
  ];

  for (const name of parameterNames) {
    if (isTrackingParameter(name)) {
      parsedUrl.searchParams.delete(name);
    }
  }

  parsedUrl.searchParams.sort();

  /**
   * 根路径必须保留 "/"：
   * https://example.com/
   *
   * 非根路径删除末尾多余斜线：
   * /company/// -> /company
   */
  if (parsedUrl.pathname !== "/") {
    parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/u, "") || "/";
  }

  return parsedUrl.toString();
};
/**
 * 按 canonical URL 去重。
 *
 * 输入顺序代表搜索排名，因此保留第一次出现的结果。
 */
export const deduplicateSearchHits = (
  untrustedHits: readonly UncanonicalizedSearchHit[],
): SearchHit[] => {
  const seenCanonicalUrls = new Set<string>();
  const normalizedHits: SearchHit[] = [];
  for (const hit of untrustedHits) {
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeWebUrl(hit.url);
    } catch {
      /**
       * 单条供应商结果非法时丢弃，
       * 不能让整个搜索结果不可用。
       */
      continue;
    }

    if (seenCanonicalUrls.has(canonicalUrl)) {
      continue;
    }

    const parsedHit = SearchHitSchema.safeParse({ ...hit, canonicalUrl });
    if (!parsedHit.success) {
      continue;
    }
    seenCanonicalUrls.add(canonicalUrl);
    normalizedHits.push(parsedHit.data);
  }
  return normalizedHits;
};

/**
 * 阻止访问特定的 IPv4 和 IPv6 地址范围。
 * 这些地址通常用于本地网络、保留地址或多播地址。
 */
const blockedIpv4Addresses = new BlockList();
blockedIpv4Addresses.addSubnet("0.0.0.0", 8, "ipv4");
blockedIpv4Addresses.addSubnet("10.0.0.0", 8, "ipv4");
blockedIpv4Addresses.addSubnet("100.64.0.0", 10, "ipv4");
blockedIpv4Addresses.addSubnet("127.0.0.0", 8, "ipv4");
blockedIpv4Addresses.addSubnet("169.254.0.0", 16, "ipv4");
blockedIpv4Addresses.addSubnet("172.16.0.0", 12, "ipv4");
blockedIpv4Addresses.addSubnet("192.0.0.0", 24, "ipv4");
blockedIpv4Addresses.addSubnet("192.0.2.0", 24, "ipv4");
blockedIpv4Addresses.addSubnet("192.168.0.0", 16, "ipv4");
blockedIpv4Addresses.addSubnet("198.18.0.0", 15, "ipv4");
blockedIpv4Addresses.addSubnet("198.51.100.0", 24, "ipv4");
blockedIpv4Addresses.addSubnet("203.0.113.0", 24, "ipv4");
blockedIpv4Addresses.addSubnet("224.0.0.0", 4, "ipv4");
blockedIpv4Addresses.addSubnet("240.0.0.0", 4, "ipv4");

const blockedIpv6Addresses = new BlockList();
blockedIpv6Addresses.addAddress("::", "ipv6");
blockedIpv6Addresses.addAddress("::1", "ipv6");
blockedIpv6Addresses.addSubnet("fc00::", 7, "ipv6");
blockedIpv6Addresses.addSubnet("fe80::", 10, "ipv6");
blockedIpv6Addresses.addSubnet("ff00::", 8, "ipv6");
blockedIpv6Addresses.addSubnet("2001:db8::", 32, "ipv6");
/**
 * IPv4-mapped IPv6 地址可能绕过单独的 IPv4 检查：
 * ::ffff:127.0.0.1
 *
 * 当前策略保守地拒绝全部 IPv4-mapped IPv6 地址。
 */
blockedIpv6Addresses.addSubnet("::ffff:0:0", 96, "ipv6");

const isPublicIpAddress = (
  address: string,
  expectedFamily?: 4 | 6,
): boolean => {
  const detectedFamily = isIP(address);

  if (detectedFamily === 0) {
    return false;
  }

  if (expectedFamily !== undefined && detectedFamily !== expectedFamily) {
    return false;
  }

  if (detectedFamily === 4) {
    return !blockedIpv4Addresses.check(address, "ipv4");
  }

  return !blockedIpv6Addresses.check(address, "ipv6");
};

const defaultHostnameResolver: HostnameResolver = async (hostname) => {
  const addresses = await lookup(hostname, {
    all: true,
    verbatim: true,
  });

  return addresses.map((item) => {
    if (item.family !== 4 && item.family !== 6) {
      throw new Error("WEB_URL_DNS_FAMILY_UNSUPPORTED");
    }
    return {
      address: item.address,
      family: item.family,
    };
  });
};

const normalizeHostname = (hostname: string): string => {
  /**
   * URL.hostname 对 IPv6 地址可能保留方括号。
   */
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }

  return hostname.toLowerCase();
};

/**
 * 校验 URL 是否只能访问公网 HTTP(S) 资源。
 *
 * 注意：
 * 该检查不能单独防止完整的 DNS Rebinding。
 * Task 5.3 的 HTTP Adapter 必须把已校验地址绑定到真实连接，
 * 并对每一次重定向重新调用本函数。
 */
export const assertPublicWebUrl = async (
  untrustedUrl: string,
  resolver: HostnameResolver = defaultHostnameResolver,
): Promise<string> => {
  const parsedUrl = parseHttpUrl(untrustedUrl);
  const hostname = normalizeHostname(parsedUrl.hostname);

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("WEB_URL_NOT_PUBLIC");
  }

  const literalIpFamily = isIP(hostname);

  if (literalIpFamily !== 0) {
    if (!isPublicIpAddress(hostname, literalIpFamily === 4 ? 4 : 6)) {
      throw new Error("WEB_URL_NOT_PUBLIC");
    }

    return canonicalizeWebUrl(parsedUrl.toString());
  }

  let resolvedAddresses: readonly ResolvedHostnameAddress[];

  try {
    resolvedAddresses = await resolver(hostname);
  } catch {
    throw new Error("WEB_URL_DNS_LOOKUP_FAILED");
  }

  if (
    resolvedAddresses.length === 0 ||
    resolvedAddresses.some(
      ({ address, family }) => !isPublicIpAddress(address, family),
    )
  ) {
    throw new Error("WEB_URL_NOT_PUBLIC");
  }

  return canonicalizeWebUrl(parsedUrl.toString());
};
