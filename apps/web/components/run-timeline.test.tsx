// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { RunProgressEvent } from "@insightforge/domain";
import type * as ApiClient from "@/lib/api-client";
import { RunTimeline } from "./run-timeline";
import {
  cancelResearchRun,
  getResearchRun,
  parseRunProgressEvent,
} from "@/lib/api-client";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const original = await importOriginal<typeof ApiClient>();
  return {
    ...original,
    getResearchRun: vi.fn(),
    cancelResearchRun: vi.fn(),
    parseRunProgressEvent: vi.fn(),
  };
});

const RUN_ID = "00000000-0000-4000-8000-000000000011";

class FakeEventSource {
  static latest: FakeEventSource;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, EventListener>();

  constructor(readonly url: string) {
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, listener);
  }

  close() {}

  emit(type: string, event: RunProgressEvent) {
    this.listeners.get(type)?.(
      new MessageEvent(type, { data: JSON.stringify(event) }),
    );
  }
}

const summary = {
  runId: RUN_ID,
  company: "字节跳动",
  focus: "comprehensive",
  depth: "quick",
  status: "running" as const,
  tokenUsage: 0,
  estimatedCostCny: 0,
  createdAt: "2026-09-05T08:00:00.000Z",
  updatedAt: "2026-09-05T08:00:01.000Z",
};

const progressEvent: RunProgressEvent = {
  id: 1,
  runId: RUN_ID,
  type: "progress",
  status: "running",
  stage: "planning",
  message: "Agent 开始规划企业调研任务",
  progress: 10,
  occurredAt: "2026-09-05T08:00:02.000Z",
  data: {},
};

describe("RunTimeline", () => {
  beforeEach(() => {
    vi.mocked(getResearchRun).mockResolvedValue(summary);
    vi.mocked(cancelResearchRun).mockResolvedValue(undefined);
    vi.mocked(parseRunProgressEvent).mockImplementation((value) =>
      JSON.parse(value),
    );
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("显示 SSE 阶段并在取消成功后切换为终态", async () => {
    render(createElement(RunTimeline, { runId: RUN_ID }));

    expect(
      await screen.findByRole("heading", { name: "字节跳动" }),
    ).toBeVisible();
    expect(FakeEventSource.latest.url).toBe(`/api/runs/${RUN_ID}/events`);

    act(() => FakeEventSource.latest.emit("progress", progressEvent));
    expect(screen.getByText("正在规划调研问题")).toBeVisible();
    expect(screen.getAllByText("Agent 开始规划企业调研任务")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "取消调研" }));
    await waitFor(() => expect(cancelResearchRun).toHaveBeenCalledWith(RUN_ID));
    expect(await screen.findByText("调研已取消")).toBeVisible();
  });

  it("已完成任务提供稳定的报告链接", async () => {
    vi.mocked(getResearchRun).mockResolvedValue({
      ...summary,
      status: "completed",
    });
    render(createElement(RunTimeline, { runId: RUN_ID }));

    expect(await screen.findAllByText("企业调研报告已生成")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "阅读完整报告" })).toHaveAttribute(
      "href",
      `/reports/${RUN_ID}`,
    );
  });
});
