import { describe, expect, it } from "vitest";

import {
  CompleteResearchRunInputSchema,
  CreateResearchRunSchema,
  ResearchRunSchema,
  RunCheckpointInputSchema,
  RunCheckpointKeySchema,
} from "./research";

const runId = "550e8400-e29b-41d4-a716-446655440000";

describe("CreateResearchRunSchema", () => {
  it("接受合法的调研任务输入并清理字符串首尾空格", () => {
    const result = CreateResearchRunSchema.parse({
      ownerId: " user-1 ",
      company: " 字节跳动 ",
      focus: "technology",
      depth: "quick",
    });

    expect(result).toEqual({
      ownerId: "user-1",
      company: "字节跳动",
      focus: "technology",
      depth: "quick",
    });
  });

  it("拒绝过短的公司名称和未知调研方向", () => {
    expect(
      CreateResearchRunSchema.safeParse({
        ownerId: "user-1",
        company: "A",
        focus: "finance",
        depth: "quick",
      }).success,
    ).toBe(false);
  });
});

describe("ResearchRunSchema", () => {
  it("接受合法的完整调研任务", () => {
    const now = new Date("2026-08-13T08:00:00.000Z");

    expect(
      ResearchRunSchema.parse({
        id: runId,
        ownerId: "user-1",
        company: "字节跳动",
        focus: "comprehensive",
        depth: "deep",
        status: "running",
        tokenUsage: 120,
        estimatedCostCny: 0.32,
        createdAt: now,
        updatedAt: now,
      }),
    ).toMatchObject({ id: runId, status: "running", tokenUsage: 120 });
  });

  it("拒绝负数用量和字符串日期", () => {
    const result = ResearchRunSchema.safeParse({
      id: runId,
      ownerId: "user-1",
      company: "字节跳动",
      focus: "comprehensive",
      depth: "quick",
      status: "queued",
      tokenUsage: -1,
      estimatedCostCny: -0.01,
      createdAt: "2026-08-13T08:00:00.000Z",
      updatedAt: "2026-08-13T08:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });
});

describe("CompleteResearchRunInputSchema", () => {
  it("接受非负的 Token 用量和预估成本", () => {
    expect(
      CompleteResearchRunInputSchema.parse({
        tokenUsage: 59068,
        estimatedCostCny: 0.12,
      }),
    ).toEqual({
      tokenUsage: 59068,
      estimatedCostCny: 0.12,
    });
  });

  it.each([
    { tokenUsage: -1, estimatedCostCny: 0 },
    { tokenUsage: 1.5, estimatedCostCny: 0 },
    { tokenUsage: 1, estimatedCostCny: -0.01 },
    { tokenUsage: 1, estimatedCostCny: 0, status: "completed" },
  ])("拒绝非法完成输入：%j", (input) => {
    expect(CompleteResearchRunInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("RunCheckpointInputSchema", () => {
  it("接受可序列化的嵌套JSON状态", () => {
    const result = RunCheckpointInputSchema.parse({
      checkpointKey: "after-planning",
      state: {
        step: 2,
        completed: false,
        tags: ["company", "technology"],
        metadata: { retryCount: 0, note: null },
      },
    });

    expect(result.state).toMatchObject({ step: 2, completed: false });
  });

  it.each([
    ["Date", new Date()],
    ["函数", () => "not-json"],
    ["undefined", undefined],
  ])("拒绝JSON不支持的%s值", (_label, value) => {
    expect(
      RunCheckpointInputSchema.safeParse({
        checkpointKey: "invalid-state",
        state: { value },
      }).success,
    ).toBe(false);
  });
});

describe("RunCheckpointKeySchema", () => {
  it("清理检查点名称首尾空格", () => {
    expect(RunCheckpointKeySchema.parse(" request ")).toBe("request");
  });

  it.each(["", "   ", "a".repeat(129)])(
    "拒绝非法检查点名称：%j",
    (checkpointKey) => {
      expect(RunCheckpointKeySchema.safeParse(checkpointKey).success).toBe(
        false,
      );
    },
  );
});
