import { ResearchDepthSchema, type ResearchDepth } from "@insightforge/domain";
import z from "zod";

/**
 * Agent 即将执行的操作类型。
 *
 * model：会消耗 Token 和模型成本；
 * search：会消耗搜索额度；
 * deterministic：纯服务端计算，不产生外部调用成本。
 */
export const ResearchOperationKindSchema = z.enum([
  "model",
  "search",
  "deterministic",
]);

export type ResearchOperationKind = z.infer<typeof ResearchOperationKindSchema>;

/**
 * 单种调研深度的预算配置。
 */
export const ResearchBudgetSchema = z
  .object({
    maxSearchCount: z.int().nonnegative(),
    maxTokenUsage: z.int().nonnegative(),
    maxEstimatedCostCny: z.number().finite().nonnegative(),
    maxDurationMs: z.int().positive(),
  })
  .strict();

export type ResearchBudget = z.infer<typeof ResearchBudgetSchema>;

/**
 * quick 和 deep 必须分别提供预算。
 */
export const ResearchBudgetsSchema = z
  .object({
    quick: ResearchBudgetSchema,
    deep: ResearchBudgetSchema,
  })
  .strict();

export type ResearchBudgets = z.infer<typeof ResearchBudgetsSchema>;

/**
 * 项目设计中的默认预算。
 */
export const DEFAULT_RESEARCH_BUDGETS: ResearchBudgets =
  ResearchBudgetsSchema.parse({
    quick: {
      maxSearchCount: 12,
      maxTokenUsage: 80_000,
      maxEstimatedCostCny: 5,
      maxDurationMs: 5 * 60 * 1000,
    },
    deep: {
      maxSearchCount: 30,
      maxTokenUsage: 200_000,
      maxEstimatedCostCny: 15,
      maxDurationMs: 15 * 60 * 1000,
    },
  });
/**
 * 单次外部操作的超时。
 *
 * 总运行期限由 deadlineAt 控制；
 * 这里限制一次模型或搜索请求最多占用多久。
 */
export const ResearchOperationTimeoutsSchema = z
  .object({
    modelMs: z.int().positive(),
    searchMs: z.int().positive(),
  })
  .strict();

export type ResearchOperationTimeouts = z.infer<
  typeof ResearchOperationTimeoutsSchema
>;

export const DEFAULT_RESEARCH_OPERATION_TIMEOUTS: ResearchOperationTimeouts =
  ResearchOperationTimeoutsSchema.parse({
    modelMs: 120_000,
    searchMs: 30_000,
  });

export const ResearchExecutionLimitSchema = z.enum([
  "AGENT_DEADLINE_EXCEEDED",
  "AGENT_SEARCH_BUDGET_EXCEEDED",
  "AGENT_TOKEN_BUDGET_EXCEEDED",
  "AGENT_COST_BUDGET_EXCEEDED",
]);

export type ResearchExecutionLimitCode = z.infer<
  typeof ResearchExecutionLimitSchema
>;

/**
 * 预算或期限耗尽属于不可通过 BullMQ 重试恢复的错误。
 */
export class ResearchExecutionLimitError extends Error {
  readonly code: ResearchExecutionLimitCode;
  constructor(code: ResearchExecutionLimitCode) {
    super(code);
    this.name = "ResearchExecutionLimitError";
    this.code = code;
  }
}
export const isResearchExecutionLimitError = (
  error: unknown,
): error is ResearchExecutionLimitError =>
  error instanceof ResearchExecutionLimitError;

/**
 * 预算检查需要的 State 子集。
 *
 * 不直接依赖完整 LangGraph State，
 * 让该策略保持为可单独测试的纯函数。
 */
export interface ResearchBudgetUsage {
  depth: ResearchDepth;
  startedAt: string;
  deadlineAt: string;
  searchCount: number;
  tokenUsage: number;
  estimatedCostCny: number;
}
export interface AssertResearchBudgetInput {
  usage: ResearchBudgetUsage;
  budget: ResearchBudget;
  operation: ResearchOperationKind;
  now: Date;
  additionalSearches?: number;
}

/**
 * 检查下一次操作是否允许执行。
 *
 * 返回距离有效截止时间还剩多少毫秒，
 * Graph 可以用它限制单次外部请求的 timeout。
 */
export const assertWithinResearchBudget = ({
  usage,
  budget: untrustedBudget,
  operation: untrustedOperation,
  now,
  additionalSearches = 0,
}: AssertResearchBudgetInput): number => {
  if (!Number.isInteger(additionalSearches) || additionalSearches < 0) {
    throw new Error("AGENT_ADDITIONAL_SEARCHES_INVALID");
  }
  const budget = ResearchBudgetSchema.parse(untrustedBudget);
  const operation = ResearchOperationKindSchema.parse(untrustedOperation);
  const parsedDepth = ResearchDepthSchema.parse(usage.depth);
  const startedAtMs = Date.parse(usage.startedAt);
  const deadlineAtMs = Date.parse(usage.deadlineAt);
  const nowMs = now.getTime();

  if (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(deadlineAtMs) ||
    !Number.isFinite(nowMs)
  ) {
    throw new Error("AGENT_EXECUTION_TIME_INVALID");
  }

  if (
    !Number.isInteger(usage.searchCount) ||
    usage.searchCount < 0 ||
    !Number.isInteger(usage.tokenUsage) ||
    usage.tokenUsage < 0 ||
    !Number.isFinite(usage.estimatedCostCny) ||
    usage.estimatedCostCny < 0
  ) {
    throw new Error("AGENT_BUDGET_USAGE_INVALID");
  }

  /**
   * 同时使用：
   *
   * 1. State 中保存的 deadlineAt；
   * 2. startedAt + 当前配置的 maxDurationMs。
   *
   * 即使检查点中的 deadlineAt 被错误延长，
   * 也不能突破服务端预算配置。
   */
  const configuredDeadlineAtMs = startedAtMs + budget.maxDurationMs;
  const effectiveDeadlineAtMs = Math.min(deadlineAtMs, configuredDeadlineAtMs);

  if (nowMs >= effectiveDeadlineAtMs) {
    throw new ResearchExecutionLimitError("AGENT_DEADLINE_EXCEEDED");
  }

  if (
    operation === "search" &&
    usage.searchCount + additionalSearches > budget.maxSearchCount
  ) {
    throw new ResearchExecutionLimitError("AGENT_SEARCH_BUDGET_EXCEEDED");
  }

  if (operation === "model" && usage.tokenUsage >= budget.maxTokenUsage) {
    throw new ResearchExecutionLimitError("AGENT_TOKEN_BUDGET_EXCEEDED");
  }

  if (
    operation === "model" &&
    usage.estimatedCostCny >= budget.maxEstimatedCostCny
  ) {
    throw new ResearchExecutionLimitError("AGENT_COST_BUDGET_EXCEEDED");
  }
  void parsedDepth; // 目前没有使用 depth，但保留类型检查

  return effectiveDeadlineAtMs - nowMs;
};
