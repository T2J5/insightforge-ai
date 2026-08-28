import type { StructuredModel } from "@insightforge/domain";
import {
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";

import {
  ResearchAgentState,
  ReportDraftSchema,
  ResearchPlanSchema,
  ReviewResultSchema,
  type ResearchAgentStateValue,
} from "./state";
import {
  ResearchFindingSchema,
  ResearchToolInputSchema,
  type ResearchFinding,
  type ResearchTool,
} from "./tools/research-tool";

import { extractEvidenceCandidates } from "./evidence-extractor";
import { validateReportCitations } from "./report-citation";
import {
  assertWithinResearchBudget,
  DEFAULT_RESEARCH_BUDGETS,
  DEFAULT_RESEARCH_OPERATION_TIMEOUTS,
  ResearchBudgetsSchema,
  ResearchOperationTimeoutsSchema,
  type ResearchBudgets,
  type ResearchOperationKind,
  type ResearchOperationTimeouts,
} from "./budgets";

export interface ResearchExecutionGuard {
  assertNotCancelled(runId: string): Promise<void>;
}

/**
 * Agent 图需要的外部能力。
 *
 * model：
 * 负责规划、写作和评审。
 *
 * researchTool：
 * 负责获取模型参数之外的外部资料。
 */
export interface ResearchAgentGraphDependencies {
  model: StructuredModel;
  researchTool: ResearchTool;
  executionGuard: ResearchExecutionGuard;
  /**
   * 可选的 LangGraph 状态持久化实现。
   *
   * 测试和示例可以不传；
   * 生产 Worker 传入 PostgresSaver。
   */
  checkpointer?: BaseCheckpointSaver;
  budgets?: ResearchBudgets;
  operationTimeouts?: ResearchOperationTimeouts;
  now?: () => Date;
}

export type AfterReviewRoute = "writer" | "publisher";

/**
 * reviewer 执行完成后的确定性路由。
 *
 * 路由决策由服务端代码控制，
 * 不能让模型自行决定是否无限修订。
 */
export const afterReview = (
  state: ResearchAgentStateValue,
): AfterReviewRoute => {
  if (!state.review) {
    throw new Error("REVIEW_RESULT_REQUIRED");
  }
  if (state.review.passed) return "publisher";

  /**
   * 最多修订一次。
   *
   * revisionCount === 0：
   * 返回 writer 进行第一次修订。
   *
   * revisionCount >= 1：
   * 即使仍未通过，也不再循环。
   */
  return state.revisionCount < 1 ? "writer" : "publisher";
};

export type AfterCitationValidationRoute = "writer" | "reviewer";
/**
 * citationValidator 后的确定性路由。
 */
export const afterCitationValidation = (
  state: ResearchAgentStateValue,
): AfterCitationValidationRoute => {
  /**
   * 没有引用问题，进入模型 reviewer。
   */
  if (state.citationIssues.length === 0) return "reviewer";

  /**
   * 第一次引用错误允许 writer 修订。
   */
  if (state.citationRevisionCount < 1) return "writer";
  /**
   * 修订后引用仍不合法时停止工作流。
   *
   * 不能发布带伪造引用的报告，
   * 也不能无限调用模型。
   */
  throw new Error("REPORT_CITATIONS_INVALID");
};

/**
 * 把一次模型调用的用量转换成 State 增量。
 *
 * State 中保存总 Token，
 * 因此需要把输入和输出 Token 相加。
 */
const formatUsage = (usage: {
  inputTokens: number;
  outputTokens: number;
  costCny: number;
}) => ({
  tokenUsage: usage.inputTokens + usage.outputTokens,
  estimatedCostCny: usage.costCny,
});

/**
 * 创建一个编译后的企业调研 Agent 图。
 */
export const createResearchGraph = ({
  model,
  researchTool,
  executionGuard,
  checkpointer,
  budgets: untrustedBudgets = DEFAULT_RESEARCH_BUDGETS,
  operationTimeouts:
    untrustedOperationTimeouts = DEFAULT_RESEARCH_OPERATION_TIMEOUTS,
  now = () => new Date(),
}: ResearchAgentGraphDependencies) => {
  const budgets = ResearchBudgetsSchema.parse(untrustedBudgets);
  const operationTimeouts = ResearchOperationTimeoutsSchema.parse(
    untrustedOperationTimeouts,
  );

  const prepareOperation = async (
    state: ResearchAgentStateValue,
    operation: ResearchOperationKind,
    additionalSearches = 0,
  ): Promise<number> => {
    await executionGuard.assertNotCancelled(state.runId);
    const remainingDeadlineMs = assertWithinResearchBudget({
      usage: {
        depth: state.depth,
        startedAt: state.startedAt,
        deadlineAt: state.deadlineAt,
        searchCount: state.searchCount,
        tokenUsage: state.tokenUsage,
        estimatedCostCny: state.estimatedCostCny,
      },

      budget: budgets[state.depth],

      operation,

      additionalSearches,

      now: now(),
    });

    if (operation === "model") {
      return Math.min(remainingDeadlineMs, operationTimeouts.modelMs);
    }
    if (operation === "search") {
      return Math.min(remainingDeadlineMs, operationTimeouts.searchMs);
    }
    return remainingDeadlineMs;
  };
  /**
   * planner：根据用户输入生成结构化调研计划。
   */
  const planner: typeof ResearchAgentState.Node = async (state) => {
    const timeoutMs = await prepareOperation(state, "model");
    const result = await model.generate(ResearchPlanSchema, {
      operation: "plan-research",
      timeoutMs,
      messages: [
        {
          role: "system",
          content:
            "你是企业调研规划助手。" +
            "请根据企业、调研方向和深度，" +
            "生成结构化的调研目标和问题列表。" +
            "quick 调研生成 3 个核心问题，" +
            "deep 调研生成不超过 6 个问题。",
        },
        {
          role: "user",
          content: [
            `企业：${state.company}`,
            `调研方向：${state.focus}`,
            `调研深度：${state.depth}`,
          ].join("\n"),
        },
      ],
    });
    /**
     * 不能只依赖 Prompt 控制问题数量。
     *
     * 模型可能不严格遵循数量要求，
     * 所以由服务端代码提供最终的成本保护。
     */
    const maxQuestions = state.depth === "quick" ? 3 : 6;
    const limitedPlan = {
      ...result.value,
      questions: result.value.questions.slice(0, maxQuestions),
    };

    /**
     * Node 不修改 state，
     * 只返回这次执行产生的局部更新。
     */
    return {
      plan: limitedPlan,
      status: "researching",
      visitedNodes: "planner",
      ...formatUsage(result.usage),
    };
  };
  /**
   * researcher：
   * 针对调研计划中的每一个问题调用工具。
   *
   * researcher 本身不调用模型。
   */
  const researcher: typeof ResearchAgentState.Node = async (state) => {
    if (!state.plan) {
      throw new Error("RESEARCH_PLAN_REQUIRED");
    }
    // 检查点恢复时跳过已经完成的问题
    const completedBefore = new Set(state.completedQuestionIds);
    const pendingQuestions = state.plan.questions.filter((question) => {
      return !completedBefore.has(question.id);
    });
    const newFindings: ResearchFinding[] = [];
    const completedQuestionIds: string[] = [];
    /**
     * 使用顺序执行，而不是 Promise.all。
     *
     * 这样每个外部搜索之间都能重新检查：
     * - Redis 取消标志；
     * - deadline；
     * - 搜索预算。
     */
    for (const question of pendingQuestions) {
      const timeoutMs = await prepareOperation(
        state,
        "search",
        // state.searchCount 尚未包含本节点已经完成的搜索, 因此把本地增量一并传给预算检查。
        completedQuestionIds.length + 1,
      );
      const toolInput = ResearchToolInputSchema.parse({
        company: state.company,
        focus: state.focus,
        depth: state.depth,
        questionId: question.id,
        question: question.question,
        timeoutMs,
      });
      const toolOutput = await researchTool.research(toolInput);
      /**
       * 工具实现可能来自外部 SDK，
       * TypeScript 类型不能保证运行时返回值正确，
       * 所以工具输出也需要进行 Zod 校验。
       */
      const finding = ResearchFindingSchema.parse(toolOutput);
      /**
       * 防止工具把 q1 的结果错误标记成 q2。
       */
      if (finding.questionId !== question.id) {
        throw new Error(`RESEARCH_FINDING_QUESTION_MISMATCH`);
      }
      newFindings.push(finding);
      completedQuestionIds.push(question.id);
    }
    return {
      findings: [...state.findings, ...newFindings],
      searchCount: newFindings.length,
      completedQuestionIds,
      status: "extracting_evidence",
      visitedNodes: "researcher",
    };
  };
  /**
   * evidenceExtractor：
   *
   * 使用一次结构化模型调用，
   * 从全部调研资料中提取 claim + quote，
   * 然后由服务端验证引用真实性。
   */
  const evidenceExtractor: typeof ResearchAgentState.Node = async (state) => {
    const timeoutMs = await prepareOperation(state, "model");
    if (!state.plan) {
      throw new Error("RESEARCH_PLAN_REQUIRED");
    }

    if (state.findings.length === 0) {
      throw new Error("RESEARCH_FINDINGS_REQUIRED");
    }

    const result = await extractEvidenceCandidates({
      model,
      questions: state.plan.questions.map((question) => ({
        id: question.id,
        question: question.question,
      })),
      findings: state.findings,
      timeoutMs,
    });
    return {
      evidenceCandidates: result.candidates,
      status: "writing",
      visitedNodes: "evidenceExtractor",
      ...formatUsage(result.usage),
    };
  };
  /**
   * writer：第一次撰写或根据评审意见修订。
   */
  const writer: typeof ResearchAgentState.Node = async (state) => {
    const timeoutMs = await prepareOperation(state, "model");
    if (!state.plan) {
      throw new Error("RESEARCH_PLAN_REQUIRED");
    }
    if (state.findings.length === 0) {
      throw new Error("RESEARCH_FINDINGS_REQUIRED");
    }
    if (state.evidenceCandidates.length === 0) {
      throw new Error("GROUNDED_EVIDENCE_REQUIRED");
    }

    const isReviewRevision = state.review !== null && !state.review.passed;
    const isCitationRevision = state.citationIssues.length > 0;
    const isRevision = isReviewRevision || isCitationRevision;
    const revisionIssues = [
      ...(isReviewRevision ? (state.review?.issues ?? []) : []),
      ...state.citationIssues.map(
        (issue) => `${issue.location}: ${issue.message}`,
      ),
    ];

    const result = await model.generate(ReportDraftSchema, {
      operation: isRevision ? "revise-report" : "write-report",
      timeoutMs,
      messages: [
        {
          role: "system",
          content: isRevision
            ? "你是企业调研报告修订助手。" +
              "请根据修订问题和已验证证据修订报告。" +
              "所有事实性结论只能来自 evidenceCandidates。" +
              "executiveSummaryEvidenceIds 必须声明执行摘要使用的证据 ID。" +
              "每个 section 的 evidenceIds 必须声明该章节使用的证据 ID。" +
              "只能使用 evidenceCandidates 中存在的 evidenceId。" +
              "不要为了满足引用要求而添加证据无法支持的事实。"
            : "你是企业调研报告撰写助手。" +
              "请根据调研计划和已验证证据生成结构化报告。" +
              "所有事实性结论只能来自 evidenceCandidates。" +
              "executiveSummaryEvidenceIds 必须声明执行摘要使用的证据 ID。" +
              "每个 section 的 evidenceIds 必须声明该章节使用的证据 ID。" +
              "只能使用 evidenceCandidates 中存在的 evidenceId。" +
              "如果证据不足，请缩小结论范围，不得编造事实或证据 ID。",
        },
        {
          role: "user",
          content: JSON.stringify({
            company: state.company,
            focus: state.focus,
            depth: state.depth,
            plan: state.plan,
            evidenceCandidates: state.evidenceCandidates,
            previousDraft: isRevision ? state.draft : null,
            revisionIssues,
          }),
        },
      ],
    });
    return {
      draft: result.value,
      review: null, // 修订后需要重新评审
      /**
       * writer 已经处理旧的引用问题，
       * 下一节点重新验证新报告。
       */
      citationIssues: [],
      revisionCount: isReviewRevision ? 1 : 0,
      citationRevisionCount: isCitationRevision ? 1 : 0,
      status: "validating_citations",
      visitedNodes: "writer",
      ...formatUsage(result.usage),
    };
  };

  /**
   * citationValidator：
   *
   * 确定性验证报告中的 Evidence ID。
   *
   * 该节点不调用模型，
   * 所以不会增加 Token 和模型成本。
   */
  const citationValidator: typeof ResearchAgentState.Node = async (state) => {
    await prepareOperation(state, "deterministic");
    if (!state.draft) throw new Error("REPORT_DRAFT_REQUIRED");

    if (state.evidenceCandidates.length === 0) {
      throw new Error("GROUNDED_EVIDENCE_REQUIRED");
    }
    const validation = validateReportCitations(
      state.draft,
      state.evidenceCandidates,
    );

    return {
      citationIssues: validation.issues,
      status: validation.valid ? "reviewing" : "writing",
      visitedNodes: "citationValidator",
    };
  };

  /**
   * reviewer：对照计划、调研发现和报告草稿进行评审。
   */
  const reviewer: typeof ResearchAgentState.Node = async (state) => {
    const timeoutMs = await prepareOperation(state, "model");
    if (state.citationIssues.length > 0) {
      throw new Error("REPORT_CITATIONS_INVALID");
    }
    if (state.evidenceCandidates.length === 0) {
      throw new Error("GROUNDED_EVIDENCE_REQUIRED");
    }
    if (!state.plan) throw new Error("RESEARCH_PLAN_REQUIRED");
    if (state.findings.length === 0)
      throw new Error("RESEARCH_FINDINGS_REQUIRED");
    if (!state.draft) throw new Error("REPORT_DRAFT_REQUIRED");

    const result = await model.generate(ReviewResultSchema, {
      operation: "review-report",
      timeoutMs,
      messages: [
        {
          role: "system",
          content:
            "你是企业调研报告评审助手。" +
            "当前报告已经通过确定性 Evidence ID 校验。" +
            "请继续检查每个事实性结论是否真的得到对应 evidenceCandidates 支持，" +
            "报告是否覆盖调研计划，" +
            "以及是否存在夸大、推断过度或遗漏重要限制。" +
            "证据不足时必须降低评分并说明具体问题。",
        },
        {
          role: "user",
          content: JSON.stringify({
            plan: state.plan,
            evidenceCandidates: state.evidenceCandidates,
            draft: state.draft,
          }),
        },
      ],
    });
    return {
      review: result.value,
      status: "reviewing",
      visitedNodes: "reviewer",
      ...formatUsage(result.usage),
    };
  };

  /**
   * publisher：发布当前草稿。
   *
   * 这是确定性操作，不需要调用模型。
   */
  const publisher: typeof ResearchAgentState.Node = async (state) => {
    await prepareOperation(state, "deterministic");
    if (!state.draft) throw new Error("REPORT_DRAFT_REQUIRED");

    if (!state.review) throw new Error("REVIEW_RESULT_REQUIRED");

    if (state.evidenceCandidates.length === 0) {
      throw new Error("GROUNDED_EVIDENCE_REQUIRED");
    }

    const citationValidation = validateReportCitations(
      state.draft,
      state.evidenceCandidates,
    );
    if (!citationValidation.valid) {
      throw new Error("REPORT_CITATIONS_INVALID");
    }
    return {
      publishedReport: state.draft,
      /**
       * 一次修订后仍未通过评审时，
       * 允许输出结果，但必须附带质量警告。
       */
      qualityWarning: state.review.passed
        ? null
        : "报告在一次修订后仍未通过评审，" + "请结合评审问题进行人工复核。",
      status: "completed",
      visitedNodes: "publisher",
    };
  };

  return new StateGraph(ResearchAgentState)
    .addNode("planner", planner)
    .addNode("researcher", researcher)
    .addNode("evidenceExtractor", evidenceExtractor)
    .addNode("citationValidator", citationValidator)
    .addNode("writer", writer)
    .addNode("reviewer", reviewer)
    .addNode("publisher", publisher)

    .addEdge(START, "planner")
    .addEdge("planner", "researcher")
    .addEdge("researcher", "evidenceExtractor")
    .addEdge("evidenceExtractor", "writer")
    .addEdge("writer", "citationValidator")
    .addConditionalEdges("citationValidator", afterCitationValidation, {
      writer: "writer",
      reviewer: "reviewer",
    })
    .addConditionalEdges("reviewer", afterReview, {
      writer: "writer",
      publisher: "publisher",
    })
    .addEdge("publisher", END)
    .compile({
      checkpointer,
    });
};
