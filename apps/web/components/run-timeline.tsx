"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RunProgressEvent, RunStatus } from "@insightforge/domain";
import {
  BrowserApiError,
  cancelResearchRun,
  getResearchRun,
  parseRunProgressEvent,
  type RunSummary,
} from "@/lib/api-client";
import {
  cancellableRunStatuses,
  labelRunStage,
  mergeRunEvent,
  runStatusLabel,
  terminalRunStatuses,
} from "@/lib/run-events";

export interface RunTimelineProps {
  runId: string;
}

export function RunTimeline({ runId }: RunTimelineProps) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [events, setEvents] = useState<RunProgressEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const currentStatusRef = useRef<RunStatus | null>(null);

  const loadRun = useCallback(async () => {
    try {
      const current = await getResearchRun(runId);
      currentStatusRef.current = current.status;
      setRun(current);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof BrowserApiError
          ? cause.message
          : "未能读取调研状态，请检查网络连接后重试。",
      );
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void loadRun();

    // EventSource 会自动携带浏览器记住的 Last-Event-ID。页面刷新时服务端仍会
    // 从事件 0 回放 Redis 日志，因此“连接恢复”和“刷新恢复”都不依赖内存状态。
    const source = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/events`,
    );
    eventSourceRef.current = source;

    const receive = (message: MessageEvent<string>) => {
      const event = parseRunProgressEvent(message.data);
      if (!event || event.runId !== runId) return;
      setEvents((current) => mergeRunEvent(current, event));
      currentStatusRef.current = event.status;
      setRun((current) =>
        current ? { ...current, status: event.status } : current,
      );
      if (terminalRunStatuses.has(event.status)) source.close();
    };

    source.addEventListener("status", receive as EventListener);
    source.addEventListener("progress", receive as EventListener);
    source.addEventListener("warning", receive as EventListener);
    source.onerror = () => {
      // EventSource 会自行重连。终态关闭连接也可能触发 error，因此只在非终态
      // 显示温和提示，不把短暂断线误报成任务失败。
      if (
        currentStatusRef.current &&
        !terminalRunStatuses.has(currentStatusRef.current)
      ) {
        setError(
          "实时进度暂时中断，页面正在自动重新连接。刷新页面也不会丢失任务。",
        );
      }
    };

    return () => {
      source.close();
      eventSourceRef.current = null;
    };
  }, [loadRun, runId]);

  const cancel = async () => {
    if (!run || cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      await cancelResearchRun(runId);
      eventSourceRef.current?.close();
      currentStatusRef.current = "cancelled";
      setRun({ ...run, status: "cancelled" });
    } catch (cause) {
      setError(
        cause instanceof BrowserApiError
          ? cause.message
          : "取消请求没有完成，请稍后重试。",
      );
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
    return (
      <section
        className="run-panel"
        aria-busy="true"
        aria-label="正在读取调研状态"
      >
        <div className="run-skeleton" />
        <div className="run-skeleton run-skeleton--short" />
      </section>
    );
  }

  if (!run) {
    return (
      <section className="run-panel empty-state" role="alert">
        <h1>无法打开这次调研</h1>
        <p>{error ?? "该任务不存在，或者不属于当前浏览器会话。"}</p>
        <Link className="secondary-button" href="/">
          返回创建页面
        </Link>
      </section>
    );
  }

  const statusMessage =
    run.status === "completed"
      ? "企业调研报告已生成"
      : run.status === "cancelled"
        ? "调研已取消"
        : run.status === "failed"
          ? "调研任务执行失败"
          : (events.at(-1)?.message ?? "任务已创建，正在等待 Worker 接收");

  return (
    <section className="run-panel" aria-labelledby="run-title">
      <header className="run-panel__header">
        <div>
          <p className="mono-label">RUN {run.runId.slice(0, 8)}</p>
          <h1 id="run-title">{run.company}</h1>
          <p className="run-panel__status" aria-live="polite">
            <span
              className={`status-dot status-dot--${run.status}`}
              aria-hidden="true"
            />
            {statusMessage}
          </p>
        </div>
        <span className={`status-badge status-badge--${run.status}`}>
          {runStatusLabel(run.status)}
        </span>
      </header>

      {error ? (
        <p className="connection-notice" role="status">
          {error}
        </p>
      ) : null}

      <div
        className="run-progress"
        aria-label={`任务进度 ${events.at(-1)?.progress ?? 0}%`}
      >
        <span
          style={{
            transform: `scaleX(${(events.at(-1)?.progress ?? 0) / 100})`,
          }}
        />
      </div>

      <ol className="timeline" aria-label="Agent 执行记录">
        {events.length > 0 ? (
          events.map((event) => (
            <li key={event.id}>
              <span className="timeline__sequence">
                {String(event.id).padStart(2, "0")}
              </span>
              <div>
                <h2>{labelRunStage(event.stage)}</h2>
                <p>{event.message}</p>
                <time dateTime={event.occurredAt}>
                  {new Intl.DateTimeFormat("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  }).format(new Date(event.occurredAt))}
                </time>
              </div>
              <span className="timeline__progress">{event.progress}%</span>
            </li>
          ))
        ) : (
          <li>
            <span className="timeline__sequence">00</span>
            <div>
              <h2>{statusMessage}</h2>
              <p>事件流连接后，这里会显示每个可观察阶段。</p>
            </div>
          </li>
        )}
      </ol>

      <dl className="run-costs">
        <div>
          <dt>Token</dt>
          <dd>{run.tokenUsage.toLocaleString("zh-CN")}</dd>
        </div>
        <div>
          <dt>预估成本</dt>
          <dd>¥{run.estimatedCostCny.toFixed(2)}</dd>
        </div>
        <div>
          <dt>调研模式</dt>
          <dd>{run.depth === "quick" ? "快速" : "深度"}</dd>
        </div>
      </dl>

      <div className="run-panel__actions">
        {run.status === "completed" ? (
          <Link className="primary-button" href={`/reports/${run.runId}`}>
            阅读完整报告
          </Link>
        ) : null}
        {cancellableRunStatuses.has(run.status) ? (
          <button
            className="secondary-button"
            type="button"
            onClick={cancel}
            disabled={cancelling}
            aria-busy={cancelling}
          >
            {cancelling ? "正在取消…" : "取消调研"}
          </button>
        ) : null}
        {run.status === "failed" ? (
          <Link className="secondary-button" href="/">
            返回并重新创建
          </Link>
        ) : null}
      </div>
    </section>
  );
}
