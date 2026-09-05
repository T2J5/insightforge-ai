"use client";

import { useEffect, useRef } from "react";
import type { PublicPublishedReport } from "@insightforge/domain";

type Citation = PublicPublishedReport["citations"][number];

export interface EvidenceDrawerProps {
  citation: Citation | null;
  citationNumber: number;
  onClose(): void;
}

export function EvidenceDrawer({
  citation,
  citationNumber,
  onClose,
}: EvidenceDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (citation && dialog && !dialog.open) dialog.showModal();
    if (!citation && dialog?.open) dialog.close();
  }, [citation]);

  return (
    <dialog
      className="evidence-drawer"
      ref={dialogRef}
      aria-labelledby="evidence-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
    >
      {citation ? (
        <div className="evidence-drawer__content">
          <header>
            <p className="mono-label">CITATION {citationNumber}</p>
            <h2 id="evidence-title">来源原文</h2>
            <button
              type="button"
              aria-label="关闭引用"
              onClick={() => dialogRef.current?.close()}
            >
              ×
            </button>
          </header>
          <blockquote>{citation.quote}</blockquote>
          <dl>
            <div>
              <dt>标题</dt>
              <dd>{citation.sourceTitle ?? "来源未提供标题"}</dd>
            </div>
            <div>
              <dt>发布方</dt>
              <dd>{citation.publisher ?? "未知发布方"}</dd>
            </div>
            <div>
              <dt>来源类别</dt>
              <dd>{citation.sourceCategory}</dd>
            </div>
            <div>
              <dt>发布日期</dt>
              <dd>
                {citation.publishedAt
                  ? new Intl.DateTimeFormat("zh-CN", {
                      dateStyle: "medium",
                    }).format(new Date(citation.publishedAt))
                  : "来源未标注"}
              </dd>
            </div>
          </dl>
          <a
            className="primary-button"
            href={citation.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            在新标签页核对来源 ↗
          </a>
        </div>
      ) : null}
    </dialog>
  );
}
