import {
  EvidenceSourceCategorySchema,
  type EvidenceSourceCategory,
} from "@insightforge/domain";

import { canonicalizeWebUrl } from "./tools/search-web";

const TRUSTED_NEWS_DOMAINS = new Set([
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "bloomberg.com",
  "cnbc.com",
  "ft.com",
  "reuters.com",
  "theguardian.com",
  "wsj.com",
]);

const SECONDARY_PLATFORMS = new Set([
  "medium.com",
  "reddit.com",
  "substack.com",
  "wikipedia.org",
  "youtube.com",
]);

const hostnameMatches = (hostname: string, domain: string): boolean =>
  hostname === domain || hostname.endsWith(`.${domain}`);

export interface ClassifySourceQualityInput {
  url: string;
  officialDomains?: readonly string[];
}

export interface SourceQualityAssessment {
  category: EvidenceSourceCategory;
  priorityScore: number;
  reason: string;
}

/**
 * 该评分只用于来源排序，不能把网页内容自动变成已验证事实。
 */
export const classifySourceQuality = ({
  url,
  officialDomains = [],
}: ClassifySourceQualityInput): SourceQualityAssessment => {
  const canonicalUrl = canonicalizeWebUrl(url);
  const hostname = new URL(canonicalUrl).hostname.toLowerCase();
  const normalizedOfficialDomains = officialDomains.map((domain) =>
    domain
      .trim()
      .toLowerCase()
      .replace(/^www\./u, ""),
  );

  let assessment: SourceQualityAssessment;
  if (
    normalizedOfficialDomains.some((domain) =>
      hostnameMatches(hostname, domain),
    ) ||
    hostname.endsWith(".gov") ||
    hostname.endsWith(".gov.cn")
  ) {
    assessment = {
      category: "official",
      priorityScore: 1,
      reason: "企业官方域名或政府一手披露",
    };
  } else if (
    [...TRUSTED_NEWS_DOMAINS].some((domain) =>
      hostnameMatches(hostname, domain),
    )
  ) {
    assessment = {
      category: "trusted_news",
      priorityScore: 0.8,
      reason: "可信新闻媒体",
    };
  } else if (
    [...SECONDARY_PLATFORMS].some((domain) => hostnameMatches(hostname, domain))
  ) {
    assessment = {
      category: "secondary",
      priorityScore: 0.5,
      reason: "二手评论或内容平台",
    };
  } else {
    assessment = {
      category: "unknown",
      priorityScore: 0.25,
      reason: "未识别来源",
    };
  }

  return {
    ...assessment,
    category: EvidenceSourceCategorySchema.parse(assessment.category),
  };
};
