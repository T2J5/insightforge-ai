import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  ToolExecutionError,
  ToolRegistry,
  type ToolAuditEvent,
  type ToolExecutionContext,
} from "./tool-registry";

const runId = "00000000-0000-4000-8000-000000000001";

const createContext = (
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext => ({
  ownerId: "user-a",
  runId,
  // 通用用例使用足够远的未来时间，避免测试受实际运行日期和时刻影响。
  deadlineAt: new Date("2099-09-03T10:01:00.000Z"),
  remainingToolCalls: 2,
  signal: new AbortController().signal,
  ...overrides,
});

const EchoInputSchema = z
  .object({
    query: z.string().trim().min(1),
  })
  .strict();

const EchoOutputSchema = z.object({ value: z.string() }).strict();

const createRegistry = (
  execute = vi.fn(
    async (_context: ToolExecutionContext, input: { query: string }) => ({
      value: input.query,
    }),
  ),
  options: ConstructorParameters<typeof ToolRegistry>[0] = {},
) => {
  const registry = new ToolRegistry(options);
  registry.register({
    name: "echo",
    inputSchema: EchoInputSchema,
    outputSchema: EchoOutputSchema,
    execute,
  });
  return { registry, execute };
};

describe("ToolRegistry", () => {
  it("校验模型输入，并且不允许模型在参数中注入 ownerId", async () => {
    const { registry, execute } = createRegistry();

    await expect(
      registry.execute("echo", createContext(), {
        query: "strategy",
        ownerId: "user-b",
      }),
    ).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });

    expect(execute).not.toHaveBeenCalled();
  });

  it("把可信执行上下文原样交给工具，而不是从工具输入推导身份", async () => {
    const { registry, execute } = createRegistry();
    const context = createContext();

    await expect(
      registry.execute("echo", context, { query: " strategy " }),
    ).resolves.toEqual({ value: "strategy" });

    expect(execute).toHaveBeenCalledOnce();
    const [executionContext, input] = execute.mock.calls[0]!;
    expect(executionContext).toMatchObject({
      ownerId: context.ownerId,
      runId: context.runId,
      deadlineAt: context.deadlineAt,
      remainingToolCalls: context.remainingToolCalls,
    });
    expect(executionContext.signal).toBeInstanceOf(AbortSignal);
    expect(input).toEqual({ query: "strategy" });
  });

  it("拒绝未注册工具，且不会执行任意名称", async () => {
    const registry = new ToolRegistry();

    await expect(
      registry.execute("delete_database", createContext(), {}),
    ).rejects.toMatchObject({ code: "TOOL_NOT_FOUND" });
  });

  it.each([
    {
      name: "没有剩余调用次数",
      context: createContext({ remainingToolCalls: 0 }),
      code: "TOOL_BUDGET_EXHAUSTED",
    },
    {
      name: "执行截止时间已经到达",
      context: createContext({
        deadlineAt: new Date("2026-09-03T09:59:59.999Z"),
      }),
      code: "TOOL_DEADLINE_EXCEEDED",
    },
  ])("在$name时调用业务工具前失败", async ({ context, code }) => {
    const { registry, execute } = createRegistry(undefined, {
      now: () => new Date("2026-09-03T10:00:00.000Z"),
    });

    await expect(
      registry.execute("echo", context, { query: "strategy" }),
    ).rejects.toMatchObject({ code });
    expect(execute).not.toHaveBeenCalled();
  });

  it("尊重调用方已经取消的 AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();
    const { registry, execute } = createRegistry();

    await expect(
      registry.execute("echo", createContext({ signal: controller.signal }), {
        query: "strategy",
      }),
    ).rejects.toMatchObject({ code: "TOOL_CANCELLED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("到达单次工具超时时中止执行并返回稳定错误码", async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(
        (context: ToolExecutionContext) =>
          new Promise<{ value: string }>((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
      );
      const { registry } = createRegistry(execute, { defaultTimeoutMs: 100 });

      const result = registry.execute("echo", createContext(), {
        query: "strategy",
      });
      const assertion = expect(result).rejects.toMatchObject({
        code: "TOOL_TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(101);

      await assertion;
      expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("拒绝不符合输出 Schema 的工具结果", async () => {
    const execute = vi.fn(async () => ({ unexpected: true }));
    const { registry } = createRegistry(execute as never);

    await expect(
      registry.execute("echo", createContext(), { query: "strategy" }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_INVALID" });
  });

  it("限制序列化后的工具输出大小", async () => {
    const execute = vi.fn(async () => ({ value: "x".repeat(200) }));
    const { registry } = createRegistry(execute, { maxOutputBytes: 64 });

    await expect(
      registry.execute("echo", createContext(), { query: "strategy" }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_TOO_LARGE" });
  });

  it("记录开始和成功审计事件，但审计事件不保存原始输入与输出", async () => {
    const events: ToolAuditEvent[] = [];
    const { registry } = createRegistry(undefined, {
      audit: {
        record: vi.fn(async (event) => {
          events.push(event);
        }),
      },
      now: () => new Date("2026-09-03T10:00:00.000Z"),
    });

    await registry.execute("echo", createContext(), { query: "secret" });

    expect(events.map((event) => event.phase)).toEqual([
      "started",
      "succeeded",
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "started",
          toolName: "echo",
          ownerId: "user-a",
          runId,
        }),
        expect.objectContaining({
          phase: "succeeded",
          toolName: "echo",
          ownerId: "user-a",
          runId,
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("把未知内部异常映射成稳定错误，并记录失败审计事件", async () => {
    const events: ToolAuditEvent[] = [];
    const execute = vi.fn(async () => {
      throw new Error("postgresql password=do-not-leak");
    });
    const { registry } = createRegistry(execute, {
      audit: {
        record: vi.fn(async (event) => {
          events.push(event);
        }),
      },
    });

    const result = registry.execute("echo", createContext(), {
      query: "strategy",
    });
    await expect(result).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(result).rejects.toMatchObject({
      code: "TOOL_EXECUTION_FAILED",
    });

    const failed = events.find((event) => event.phase === "failed");
    expect(failed).toMatchObject({
      toolName: "echo",
      errorCode: "TOOL_EXECUTION_FAILED",
    });
    expect(JSON.stringify(failed)).not.toContain("password");
  });
});
