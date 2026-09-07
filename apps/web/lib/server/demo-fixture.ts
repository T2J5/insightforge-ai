import { createHash, randomUUID } from "node:crypto";

import type { ReportContent } from "@insightforge/domain";

export type DemoCompany = {
  slug: "bytedance" | "alibaba" | "xiaomi";
  company: string;
  mission: string;
  sourceUrl: string;
  sourceTitle: string;
  publisher: string;
};

export const DEMO_COMPANIES: readonly DemoCompany[] = [
  {
    slug: "bytedance",
    company: "字节跳动",
    mission: "Our mission is to inspire creativity and enrich life.",
    sourceUrl: "https://www.bytedance.com/en/",
    sourceTitle: "ByteDance - Inspire Creativity, Enrich Life",
    publisher: "ByteDance",
  },
  {
    slug: "alibaba",
    company: "阿里巴巴",
    mission: "Our mission is to make it easy to do business anywhere.",
    sourceUrl: "https://www.alibabagroup.com/en-US/about-alibaba",
    sourceTitle: "About Alibaba",
    publisher: "Alibaba Group",
  },
  {
    slug: "xiaomi",
    company: "小米集团",
    mission: "Always believe that something wonderful is about to happen.",
    sourceUrl: "https://www.mi.com/global/about/",
    sourceTitle: "About Xiaomi",
    publisher: "Xiaomi",
  },
] as const;

export const createDemoReportContent = (
  company: string,
  evidenceId: string,
): ReportContent => ({
  title: `${company}企业调研演示报告`,
  executiveSummary: [
    {
      markdown: `${company}官方网站公开了企业使命。该预置报告用于演示证据链和阅读交互，不替代实时调研。`,
      claimType: "fact",
      citationIds: [evidenceId],
    },
  ],
  sections: [
    {
      key: "company_overview",
      heading: "公司概览",
      blocks: [
        {
          markdown: `${company}的官方网站提供了企业使命和公司介绍。`,
          claimType: "fact",
          citationIds: [evidenceId],
        },
      ],
    },
    ...(
      [
        ["products_business_model", "产品与商业模式"],
        ["market_competition", "市场与竞争"],
        ["technology_innovation", "技术与创新"],
        ["recent_events", "近期动态"],
        ["strengths_risks", "优势与风险"],
        ["conclusion", "结论"],
      ] as const
    ).map(([key, heading]) => ({
      key,
      heading,
      blocks: [
        {
          markdown:
            "预置演示没有为本章节写入未经实时检索验证的事实；请创建一次新的调研任务获取当前资料。",
          claimType: "inference" as const,
          citationIds: [],
        },
      ],
    })),
  ],
});

export const createSmokeFixture = () => {
  const company = DEMO_COMPANIES[0];
  const runId = randomUUID();
  const evidenceId = randomUUID();
  const reportVersionId = randomUUID();
  return {
    company,
    runId,
    evidenceId,
    reportId: runId,
    reportVersionId,
    contentHash: createHash("sha256")
      .update(`${company.sourceUrl}\n${company.mission}`)
      .digest("hex"),
    content: createDemoReportContent(company.company, evidenceId),
  };
};
