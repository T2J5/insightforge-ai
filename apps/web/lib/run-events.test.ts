import { describe, expect, it } from "vitest";
import type { RunProgressEvent } from "@insightforge/domain";
import { labelRunStage, mergeRunEvent, runStatusLabel } from "./run-events";

const event = (id: number, stage = "planning"): RunProgressEvent => ({
  id,
  runId: "00000000-0000-4000-8000-000000000011",
  type: "progress",
  status: "running",
  stage,
  message: "progress",
  progress: id * 10,
  occurredAt: "2026-09-05T08:00:00.000Z",
  data: {},
});

describe("run events", () => {
  it("将工作流阶段转换成用户可理解的说明", () => {
    expect(labelRunStage("planning")).toBe("正在规划调研问题");
    expect(labelRunStage("custom-stage")).toBe("custom-stage");
    expect(runStatusLabel("awaiting_review")).toBe("等待评审");
  });

  it("按事件 id 去重并恢复单调顺序", () => {
    expect(mergeRunEvent([event(2), event(1)], event(2, "writing"))).toEqual([
      event(1),
      event(2, "writing"),
    ]);
  });
});
