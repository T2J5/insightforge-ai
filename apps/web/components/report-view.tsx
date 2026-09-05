"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import type { PublicPublishedReport } from "@insightforge/domain";
import { BrowserApiError, getPublishedReport } from "@/lib/api-client";
import { EvidenceDrawer } from "./evidence-drawer";
import { QualitySummary } from "./quality-summary";

type Citation = PublicPublishedReport["citations"][number];

const SafeMarkdown = ({ value }: { value: string }) => {
  // 不使用 dangerouslySetInnerHTML。模型 Markdown 只解析为安全 React 文本节点，
  // 原始 HTML 不会进入 DOM；当前支持报告阅读所需的标题、列表和段落子集。
  const lines = value.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return (
    <div className="safe-markdown">
      {lines.map((line, index) => {
        const key = `${index}:${line.slice(0, 24)}`;
        if (line.startsWith("### ")) return <h4 key={key}>{line.slice(4)}</h4>;
        if (line.startsWith("## ")) return <h3 key={key}>{line.slice(3)}</h3>;
        if (line.startsWith("# ")) return <h3 key={key}>{line.slice(2)}</h3>;
        if (line.startsWith("- ")) return <p key={key}>• {line.slice(2)}</p>;
        return <p key={key}>{line}</p>;
      })}
    </div>
  );
};

export function ReportView({ reportId }: { reportId: string }) {
  const [report, setReport] = useState<PublicPublishedReport | null>(null);
  const [selectedCitation, setSelectedCitation] = useState<Citation | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getPublishedReport(reportId)
      .then((result) => {
        if (active) setReport(result);
      })
      .catch((cause) => {
        if (!active) return;
        setError(
          cause instanceof BrowserApiError
            ? cause.message
            : "未能读取报告，请检查网络连接后重试。",
        );
      });
    return () => {
      active = false;
    };
  }, [reportId]);

  if (error) {
    return (
      <section className="report-state" role="alert">
        <h1>报告暂时无法打开</h1>
        <p>{error}</p>
        <Link className="secondary-button" href="/">
          返回首页
        </Link>
      </section>
    );
  }

  if (!report) {
    return (
      <section className="report-state" aria-busy="true">
        <div className="run-skeleton" />
        <div className="run-skeleton run-skeleton--short" />
      </section>
    );
  }

  const citationNumber = (id: string) =>
    report.citations.findIndex((item) => item.id === id) + 1;
  const openCitation = (id: string) => {
    const citation = report.citations.find((item) => item.id === id);
    if (citation) setSelectedCitation(citation);
  };

  return (
    <>
      <article className="report-view">
        <header className="report-view__header">
          <p className="mono-label">
            PUBLISHED · V{report.version} ·{" "}
            {new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(
              new Date(report.publishedAt),
            )}
          </p>
          <h1>{report.content.title}</h1>
        </header>
        <QualitySummary report={report} />
        <section
          className="report-section report-section--summary"
          aria-labelledby="summary-title"
        >
          <h2 id="summary-title">执行摘要</h2>
          {report.content.executiveSummary.map((block, index) => (
            <ReportBlock
              key={`summary-${index}`}
              markdown={block.markdown}
              citationIds={block.citationIds}
              citationNumber={citationNumber}
              onCitation={openCitation}
            />
          ))}
        </section>
        {report.content.sections.map((section) => (
          <section className="report-section" key={section.key}>
            <h2>{section.heading}</h2>
            {section.blocks.map((block, index) => (
              <ReportBlock
                key={`${section.key}-${index}`}
                markdown={block.markdown}
                citationIds={block.citationIds}
                citationNumber={citationNumber}
                onCitation={openCitation}
              />
            ))}
          </section>
        ))}
      </article>
      <EvidenceDrawer
        citation={selectedCitation}
        citationNumber={
          selectedCitation ? citationNumber(selectedCitation.id) : 0
        }
        onClose={() => setSelectedCitation(null)}
      />
    </>
  );
}

function ReportBlock({
  markdown,
  citationIds,
  citationNumber,
  onCitation,
}: {
  markdown: string;
  citationIds: string[];
  citationNumber(id: string): number;
  onCitation(id: string): void;
}) {
  return (
    <div className="report-block">
      <SafeMarkdown value={markdown} />
      {citationIds.length > 0 ? (
        <div className="citation-list" aria-label="本段引用">
          {citationIds.map((citationId) => {
            const number = citationNumber(citationId);
            return number > 0 ? (
              <button
                type="button"
                key={citationId}
                aria-label={`查看引用 ${number}`}
                onClick={() => onCitation(citationId)}
              >
                [{number}]
              </button>
            ) : (
              <Fragment key={citationId} />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
