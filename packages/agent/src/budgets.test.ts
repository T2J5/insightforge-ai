import { describe, expect, it } from "vitest";

import {
  assertWithinResearchBudget,
  DEFAULT_RESEARCH_BUDGETS,
  ResearchExecutionLimitError,
  type AssertResearchBudgetInput,
} from "./budgets";

const baseInput: AssertResearchBudgetInput = {
  usage: {
    depth: "quick",
    startedAt: "2026-08-25T00:00:00.000Z",
    deadlineAt: "2026-08-25T00:05:00.000Z",
    searchCount: 0,
    tokenUsage: 0,
    estimatedCostCny: 0,
  },
  budget: DEFAULT_RESEARCH_BUDGETS.quick,
  operation: "model",
  now: new Date("2026-08-25T00:01:00.000Z"),
};

describe("assertWithinResearchBudget", () => {
  it("返回服务端配置与 State 截止时间中更早期限的剩余毫秒数", () => {
    expect(assertWithinResearchBudget(baseInput)).toBe(4 * 60 * 1000);

    expect(
      assertWithinResearchBudget({
        ...baseInput,
        usage: {
          ...baseInput.usage,
          deadlineAt: "2026-08-25T00:02:00.000Z",
        },
      }),
    ).toBe(60_000);
  });

  it("到达截止时间时抛出明确且不可重试的错误", () => {
    expect(() =>
      assertWithinResearchBudget({
        ...baseInput,
        now: new Date("2026-08-25T00:05:00.000Z"),
      }),
    ).toThrowError(new ResearchExecutionLimitError("AGENT_DEADLINE_EXCEEDED"));
  });

  it.each([
    {
      operation: "search" as const,
      usage: { searchCount: 11 },
      additionalSearches: 2,
      code: "AGENT_SEARCH_BUDGET_EXCEEDED",
    },
    {
      operation: "model" as const,
      usage: { tokenUsage: 80_000 },
      additionalSearches: 0,
      code: "AGENT_TOKEN_BUDGET_EXCEEDED",
    },
    {
      operation: "model" as const,
      usage: { estimatedCostCny: 5 },
      additionalSearches: 0,
      code: "AGENT_COST_BUDGET_EXCEEDED",
    },
  ])("超过 $code 对应的预算时停止", (testCase) => {
    expect(() =>
      assertWithinResearchBudget({
        ...baseInput,
        operation: testCase.operation,
        additionalSearches: testCase.additionalSearches,
        usage: { ...baseInput.usage, ...testCase.usage },
      }),
    ).toThrow(testCase.code);
  });

  it.each([-1, 1.5, Number.NaN])(
    "拒绝非法的新增搜索次数 %s",
    (additionalSearches) => {
      expect(() =>
        assertWithinResearchBudget({
          ...baseInput,
          operation: "search",
          additionalSearches,
        }),
      ).toThrow("AGENT_ADDITIONAL_SEARCHES_INVALID");
    },
  );
});
