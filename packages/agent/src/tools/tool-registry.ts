/**
 * LangGraph 与 MCP 共用的“工具执行网关”。
 *
 * 一次工具调用按以下事件流处理：
 * 1. 按注册表白名单查找工具；未注册、调用预算耗尽、已取消或已超过
 *    Run 截止时间时，立即返回稳定错误码，且不调用底层工具。
 * 2. 用输入 Schema 校验模型或 MCP 传入的不可信参数；身份、运行标识、
 *    剩余预算和取消信号只取自可信执行上下文。
 * 3. 记录不含原始输入的 `started` 审计事件，并以“单次超时”和 Run
 *    剩余时间中较小者执行工具；调用方取消与超时会共同中止底层调用。
 * 4. 校验工具输出及其序列化后的大小；成功时记录不含原始输出的
 *    `succeeded` 事件并返回结果。
 * 5. 任何执行、超时、取消或输出校验失败都会归一化为可公开的稳定错误码，
 *    并记录 `failed` 审计事件，避免内部异常和敏感数据泄露。
 */
import type { z } from "zod";

/**
 * 工具执行时使用的可信上下文。
 *
 * 这些字段只能由 Worker、认证系统或 MCP Session 提供，
 * 绝不能来自模型生成的工具参数。
 */
export interface ToolExecutionContext {
  ownerId: string;
  runId: string;
  deadlineAt: Date;
  remainingToolCalls: number;
  signal: AbortSignal;
}

/**
 * 工具审计事件所处的执行阶段
 */
export type ToolAuditPhase = "started" | "succeeded" | "failed";

/**
 * 工具审计事件。
 *
 * 注意：这里故意不保存工具原始输入和输出，防止搜索内容、
 * 私有文档片段以及其他敏感信息进入审计日志。
 */
export interface ToolAuditEvent {
  phase: ToolAuditPhase;
  toolName: string;
  ownerId: string;
  runId: string;
  occurredAt: string;
  durationMs?: number;
  errorCode?: string;
}

/**
 * 审计记录端口。
 *
 * 当前测试可以传入内存 Fake；
 * 后续 Task 9 可以接入数据库或 OpenTelemetry。
 */
export interface ToolAuditRecorder {
  record(event: ToolAuditEvent): Promise<void>;
}

/**
 * ToolRegistry 构造参数。
 */
export interface ToolRegistryOptions {
  /**
   * 单次工具调用默认超时时间。
   */
  defaultTimeoutMs?: number;
  /**
   * 工具输出序列化后的最大字节数。
   */
  maxOutputBytes?: number;
  /**
   * 可选审计记录器。
   */
  audit?: ToolAuditRecorder;
  /**
   * 注入时间函数，便于测试截止时间。
   */
  now?: () => Date;
}
/**
 * 一个可以注册到 Registry 的工具定义。
 *
 * TInput 是经过 inputSchema 校验后的输入类型；
 * TOutput 是经过 outputSchema 校验后的输出类型。
 */
export interface ToolDefinition<TInput, TOutput> {
  name: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  execute(context: ToolExecutionContext, input: TInput): Promise<TOutput>;
}
/**
 * MCP Adapter 等调用方真正需要依赖的最小接口。
 *
 * Adapter 不需要知道工具如何注册、如何审计或者如何超时，
 * 只需要知道 Registry 可以执行某个工具。
 */
export interface ToolRegistryExecutor {
  execute(
    name: string,
    context: ToolExecutionContext,
    input: unknown,
  ): Promise<unknown>;
}

/**
 * Registry 对外暴露的稳定错误。
 *
 * 不把原始 Error.message 传给外部调用方，避免数据库连接信息、
 * 文件路径和内部堆栈通过 MCP 或 Agent 输出泄露。
 */
export class ToolExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ToolExecutionError";
  }
}

/**
 * Map 内部使用的擦除泛型后的工具类型。
 *
 * Map 需要同时保存不同输入、输出类型的工具，所以不能直接保存
 * ToolDefinition<TInput, TOutput>。注册时已经用闭包保留类型安全。
 */
interface RegisteredTool {
  name: string;
  inputSchema: z.ZodType<unknown>;
  outputSchema: z.ZodType<unknown>;
  execute(context: ToolExecutionContext, input: unknown): Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB

/**
 * 计算 JSON 结果的 UTF-8 字节数。
 *
 * 不能直接使用字符串 length，因为中文字符在 UTF-8 中通常占用
 * 多个字节。
 */
const getSerializedByteLength = (value: unknown): number => {
  let serialized: string;

  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ToolExecutionError("TOOL_OUTPUT_INVALID");
  }

  if (serialized === undefined) {
    throw new ToolExecutionError("TOOL_OUTPUT_INVALID");
  }

  return Buffer.byteLength(serialized, "utf8");
};

export class ToolRegistry implements ToolRegistryExecutor {
  private readonly tools = new Map<string, RegisteredTool>();

  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly audit?: ToolAuditRecorder | undefined;
  private readonly now: () => Date;

  constructor(options: ToolRegistryOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.audit = options.audit;
    this.now = options.now ?? (() => new Date());

    if (
      !Number.isInteger(this.defaultTimeoutMs) ||
      this.defaultTimeoutMs <= 0
    ) {
      throw new Error("TOOL_DEFAULT_TIMEOUT_INVALID");
    }

    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new Error("TOOL_MAX_OUTPUT_BYTES_INVALID");
    }
  }

  /**
   * 注册一个允许执行的工具。
   *
   * Registry 同时也是工具白名单：
   * 没有注册的工具名称不能被模型或 MCP Client 执行。
   */
  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    const name = definition.name.trim();

    if (name.length === 0) {
      throw new Error("TOOL_NAME_REQUIRED");
    }

    if (this.tools.has(name)) {
      throw new Error("TOOL_ALREADY_REGISTERED");
    }

    /**
     * 通过闭包保留 definition 的 TInput/TOutput 类型，
     * Map 内部只保存统一的 unknown 接口。
     */
    this.tools.set(name, {
      name,
      inputSchema: definition.inputSchema as z.ZodType<unknown>,
      outputSchema: definition.outputSchema as z.ZodType<unknown>,
      execute: async (context, input) => {
        return definition.execute(context, input as TInput);
      },
    });
  }

  async execute(
    name: string,
    context: ToolExecutionContext,
    untrustedInput: unknown,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolExecutionError("TOOL_NOT_FOUND");
    }

    /**
     * 在执行工具之前检查业务预算。
     *
     * remainingToolCalls 由 Agent/Worker 计算，
     * 模型无权自己增加剩余次数。
     */
    if (context.remainingToolCalls <= 0) {
      throw new ToolExecutionError("TOOL_BUDGET_EXHAUSTED");
    }

    /**
     * 调用开始前就已经被取消，不应再调用底层搜索服务。
     */
    if (context.signal.aborted) {
      throw new ToolExecutionError("TOOL_CANCELLED");
    }

    const startedAt = this.now();
    /**
     * 整个 Run 的业务截止时间已经到达。
     */
    if (startedAt.getTime() >= context.deadlineAt.getTime()) {
      throw new ToolExecutionError("TOOL_DEADLINE_EXCEEDED");
    }

    /**
     * 模型输入、MCP JSON 都是不可信输入。
     *
     * safeParse 失败后只返回稳定错误码，不把完整 Zod issues 暴露给
     * 外部调用方。
     */
    const parsedInput = tool.inputSchema.safeParse(untrustedInput);
    if (!parsedInput.success) {
      throw new ToolExecutionError("TOOL_INPUT_INVALID");
    }
    await this.recordAudit({
      phase: "started",
      toolName: tool.name,
      ownerId: context.ownerId,
      runId: context.runId,
      occurredAt: startedAt.toISOString(),
    });

    /**
     * 实际超时时间取两者中较小的一个：
     *
     * 1. Registry 的单次工具超时；
     * 2. 整个 Run 距离 deadlineAt 的剩余时间。
     *
     * 因此单个工具不可能越过整个 Run 的截止时间。
     */
    const remainingDuration =
      context.deadlineAt.getTime() - startedAt.getTime();
    const timeoutMs = Math.min(this.defaultTimeoutMs, remainingDuration);
    const timeoutController = new AbortController();
    let timedOut = false;

    /**
     * 将调用方取消信号与内部超时信号组合起来。
     *
     * 任意一个 signal 中止，传给底层工具的 signal 都会中止。
     */
    const executionSignal = AbortSignal.any([
      context.signal,
      timeoutController.signal,
    ]);

    const executionContext: ToolExecutionContext = {
      ...context,
      signal: executionSignal,
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);

    try {
      const untrustedOutput = await tool.execute(
        executionContext,
        parsedInput.data,
      );
      /**
       * 某些底层工具可能忽略 AbortSignal，并在超时后仍然返回。
       * 即使如此，也不能接受已经超时的结果。
       */
      if (timedOut) {
        throw new ToolExecutionError("TOOL_TIMEOUT");
      }
      if (context.signal.aborted) {
        throw new ToolExecutionError("TOOL_CANCELLED");
      }
      /**
       * 工具实现也可能返回错误结构，所以输出同样必须校验。
       */
      const parsedOutput = tool.outputSchema.safeParse(untrustedOutput);

      if (!parsedOutput.success) {
        throw new ToolExecutionError("TOOL_OUTPUT_INVALID");
      }

      const outputBytes = getSerializedByteLength(parsedOutput.data);

      if (outputBytes > this.maxOutputBytes) {
        throw new ToolExecutionError("TOOL_OUTPUT_TOO_LARGE");
      }
      const completedAt = this.now();

      await this.recordAudit({
        phase: "succeeded",
        toolName: tool.name,
        ownerId: context.ownerId,
        runId: context.runId,
        occurredAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      });

      return parsedOutput.data;
    } catch (error) {
      const executionError = this.normalizeExecutionError(
        error,
        timedOut,
        context.signal.aborted,
      );

      const failedAt = this.now();

      await this.recordAudit({
        phase: "failed",
        toolName: tool.name,
        ownerId: context.ownerId,
        runId: context.runId,
        occurredAt: failedAt.toISOString(),
        durationMs: Math.max(0, failedAt.getTime() - startedAt.getTime()),
        errorCode: executionError.code,
      });

      throw executionError;
    } finally {
      clearTimeout(timeout);
    }
  }
  /**
   * 将底层异常转成稳定、可公开的错误码。
   */
  private normalizeExecutionError(
    error: unknown,
    timedOut: boolean,
    callerCancelled: boolean,
  ): ToolExecutionError {
    if (timedOut) {
      return new ToolExecutionError("TOOL_TIMEOUT");
    }
    if (callerCancelled) {
      return new ToolExecutionError("TOOL_CANCELLED");
    }
    if (error instanceof ToolExecutionError) {
      return error;
    }
    return new ToolExecutionError("TOOL_EXECUTION_FAILED");
  }

  /**
   * 没有配置审计器时保持空操作。
   */
  private async recordAudit(event: ToolAuditEvent): Promise<void> {
    if (!this.audit) return;
    await this.audit.record(event);
  }
}
