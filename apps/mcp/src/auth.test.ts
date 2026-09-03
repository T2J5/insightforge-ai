import { describe, expect, it } from "vitest";

import { createEnvironmentMcpSessionProvider } from "./auth";

const environment = {
  INSIGHTFORGE_MCP_OWNER_ID: "user-a",
  INSIGHTFORGE_MCP_RUN_ID: "00000000-0000-4000-8000-000000000001",
  INSIGHTFORGE_MCP_MAX_TOOL_CALLS: "2",
  INSIGHTFORGE_MCP_MAX_DURATION_MS: "60000",
};

describe("createEnvironmentMcpSessionProvider", () => {
  it("冻结可信身份并为每次调用递减进程级预算", () => {
    const provider = createEnvironmentMcpSessionProvider(
      environment,
      () => new Date("2026-09-03T00:00:00.000Z"),
    );
    const signal = new AbortController().signal;

    expect(provider.create(signal)).toMatchObject({
      ownerId: "user-a",
      remainingToolCalls: 2,
      deadlineAt: new Date("2026-09-03T00:01:00.000Z"),
    });
    expect(provider.create(signal).remainingToolCalls).toBe(1);
    expect(() => provider.create(signal)).toThrow("TOOL_BUDGET_EXHAUSTED");
  });

  it("没有可信 owner 或 run 身份时拒绝启动", () => {
    expect(() =>
      createEnvironmentMcpSessionProvider({}, () => new Date()),
    ).toThrow();
  });
});
