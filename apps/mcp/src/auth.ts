import {
  ToolExecutionError,
  type ToolExecutionContext,
} from "@insightforge/agent";
import { z } from "zod";

/**
 * MCP 层已经完成认证后的可信 Session。
 *
 * 这些字段不能来自 tools/call 的 arguments，
 * 必须由 MCP Server、HTTP 鉴权中间件或可信进程配置创建。
 */
export interface McpAuthenticatedSession {
  ownerId: string;
  runId: string;
  deadlineAt: Date;
  remainingToolCalls: number;
  signal: AbortSignal;
}

/**
 * AbortSignal 无法直接放入普通 JSON/Zod Schema，
 * 因此这里只校验可以序列化的身份字段。
 */
const McpSessionIdentitySchema = z
  .object({
    ownerId: z.string().trim().min(1).max(128),
    runId: z.uuid(),
    deadlineAt: z.date(),
    remainingToolCalls: z.int().min(0),
  })
  .strict();

/**
 * 将经过认证的 MCP Session 转换为 ToolRegistry 上下文。
 *
 * 这个函数是 MCP 与内部 ToolRegistry 之间的身份边界：
 * arguments 中即使出现 ownerId，也不能进入这里。
 */
export const createToolExecutionContext = (
  session: McpAuthenticatedSession,
): ToolExecutionContext => {
  const parsed = McpSessionIdentitySchema.parse({
    ownerId: session.ownerId,
    runId: session.runId,
    deadlineAt: session.deadlineAt,
    remainingToolCalls: session.remainingToolCalls,
  });

  if (!(session.signal instanceof AbortSignal)) {
    throw new Error("MCP_SESSION_SIGNAL_INVALID");
  }

  return {
    ...parsed,
    signal: session.signal,
  };
};

export interface McpSessionProvider {
  create(signal: AbortSignal): McpAuthenticatedSession;
}

const EnvironmentSessionSchema = z.object({
  ownerId: z.string().trim().min(1).max(128),
  runId: z.uuid(),
  maxToolCalls: z.coerce.number().int().min(1).max(1_000),
  maxDurationMs: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1_000),
});

/**
 * stdio 没有 HTTP Cookie。可信身份由启动 MCP 子进程的 Host 通过环境变量
 * 注入，并在进程启动时冻结，工具 arguments 不能覆盖这些字段。
 */
export const createEnvironmentMcpSessionProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now: () => Date = () => new Date(),
): McpSessionProvider => {
  const parsed = EnvironmentSessionSchema.parse({
    ownerId: environment.INSIGHTFORGE_MCP_OWNER_ID,
    runId: environment.INSIGHTFORGE_MCP_RUN_ID,
    maxToolCalls: environment.INSIGHTFORGE_MCP_MAX_TOOL_CALLS ?? "20",
    maxDurationMs:
      environment.INSIGHTFORGE_MCP_MAX_DURATION_MS ?? String(15 * 60 * 1_000),
  });
  const deadlineAt = new Date(now().getTime() + parsed.maxDurationMs);
  let remainingToolCalls = parsed.maxToolCalls;

  return {
    create(signal) {
      if (remainingToolCalls < 1) {
        throw new ToolExecutionError("TOOL_BUDGET_EXHAUSTED");
      }
      const currentRemaining = remainingToolCalls;
      remainingToolCalls -= 1;
      return {
        ownerId: parsed.ownerId,
        runId: parsed.runId,
        deadlineAt,
        remainingToolCalls: currentRemaining,
        signal,
      };
    },
  };
};
