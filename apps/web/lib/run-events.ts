import type { RunProgressEvent, RunStatus } from "@insightforge/domain";

export const terminalRunStatuses: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const cancellableRunStatuses: ReadonlySet<RunStatus> = new Set([
  "queued",
  "running",
  "awaiting_review",
]);

const stageLabels: Readonly<Record<string, string>> = {
  queued: "等待 Worker 接收任务",
  starting: "Worker 已接收调研任务",
  planning: "正在规划调研问题",
  searching: "正在检索公开资料",
  retrieving: "正在检索上传文档",
  evidence: "正在建立事实证据链",
  writing: "正在撰写结构化报告",
  reviewing: "正在检查引用与结论",
  publishing: "正在发布报告版本",
  completed: "企业调研报告已生成",
  failed: "调研任务执行失败",
  cancelled: "调研已取消",
};

export const labelRunStage = (stage: string): string =>
  stageLabels[stage] ?? stage;

export const mergeRunEvent = (
  events: readonly RunProgressEvent[],
  incoming: RunProgressEvent,
): RunProgressEvent[] => {
  const byId = new Map(events.map((event) => [event.id, event]));
  byId.set(incoming.id, incoming);
  return [...byId.values()].sort((left, right) => left.id - right.id);
};

export const runStatusLabel = (status: RunStatus): string => {
  const labels: Record<RunStatus, string> = {
    queued: "排队中",
    running: "调研中",
    awaiting_review: "等待评审",
    completed: "已完成",
    failed: "执行失败",
    cancelled: "已取消",
  };
  return labels[status];
};
