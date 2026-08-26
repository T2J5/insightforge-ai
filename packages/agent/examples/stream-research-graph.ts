import { FakeStructuredModel } from "@insightforge/testkit";
import { randomUUID } from "node:crypto";
import {
  createResearchGraph,
  type ResearchTool,
  type ResearchToolInput,
} from "../src";

/**
 * planner 节点返回的调研计划。
 */
const plan = {
  objective: "分析 ByteDance 的技术竞争力",

  questions: [
    {
      id: "q1",

      question: "ByteDance 的核心技术能力是什么？",

      rationale: "用于判断公司的长期技术竞争力",
    },
  ],
};

/**
 * writer 第一次生成的报告。
 */
const firstDraft = {
  title: "ByteDance 技术调研",

  executiveSummary: "ByteDance 建立了算法和数据驱动的技术体系。",

  sections: [
    {
      heading: "核心技术",

      markdown: "第一版报告内容。",
    },
  ],
};

/**
 * reviewer 第一次评审结果。
 *
 * passed=false 会触发：
 *
 * reviewer → writer
 */
const failedReview = {
  passed: false,

  score: 60,

  issues: ["缺少基础设施能力分析"],
};

/**
 * writer 根据评审问题生成的修订版。
 */
const revisedDraft = {
  title: "ByteDance 技术调研（修订版）",

  executiveSummary: "推荐算法、数据平台和基础设施共同构成技术体系。",

  sections: [
    {
      heading: "核心技术",

      markdown: "根据评审意见补充了基础设施能力分析。",
    },
  ],
};

/**
 * reviewer 第二次评审结果。
 *
 * passed=true 会触发：
 *
 * reviewer → publisher
 */
const passedReview = {
  passed: true,

  score: 90,

  issues: [],
};
const startedAt = new Date();
/**
 * Agent 的初始输入。
 *
 * plan、draft、review 等中间状态由各节点生成，
 * 不需要调用方传入。
 */
const input = {
  runId: randomUUID(),
  company: "ByteDance",

  focus: "technology" as const,

  depth: "quick" as const,

  startedAt: startedAt.toISOString(),

  deadlineAt: new Date(startedAt.getTime() + 5 * 60 * 1_000).toISOString(),
};
/**
 * 学习阶段使用的假调研工具。
 *
 * 它不会访问互联网，但行为和真实工具接口一致：
 *
 * 输入一个调研问题，
 * 返回阶段性结论和来源。
 */
class DemoResearchTool implements ResearchTool {
  readonly calls: ResearchToolInput[] = [];

  async research(input: ResearchToolInput) {
    this.calls.push(input);

    return {
      questionId: input.questionId,

      summary:
        "ByteDance 在推荐算法、" + "大规模数据处理和基础设施方面持续投入。",

      sources: [
        {
          title: "ByteDance Technology Overview",

          url: "https://example.com/bytedance-technology",

          snippet:
            "ByteDance develops recommendation systems, " +
            "data platforms and large-scale infrastructure.",
        },
      ],
    };
  }
}

/**
 * 每次创建一个新的 FakeStructuredModel。
 *
 * FakeStructuredModel 内部使用响应队列。
 * 每调用一次 generate()，就会消费一个响应。
 *
 * 当前顺序对应：
 *
 * 1. planner
 * 2. writer
 * 3. reviewer 失败
 * 4. writer 修订
 * 5. reviewer 通过
 */
const createDemoModel = () =>
  new FakeStructuredModel([
    plan,

    firstDraft,

    failedReview,

    revisedDraft,

    passedReview,
  ]);

const noOpExecutionGuard = {
  async assertNotCancelled(_runId: string): Promise<void> {},
};
const main = async (): Promise<void> => {
  console.log("\n=== LangGraph 节点局部更新 ===\n");

  /**
   * 第一张图用于观察 stream。
   */
  const streamGraph = createResearchGraph({
    model: createDemoModel(),
    researchTool: new DemoResearchTool(),
    executionGuard: noOpExecutionGuard,
  });

  /**
   * updates 模式只返回每个节点本次产生的局部更新，
   * 不返回整个 State。
   */
  const stream = await streamGraph.stream(input, {
    streamMode: "updates",
  });

  for await (const update of stream) {
    /**
     * 一次 update 的结构类似：
     *
     * {
     *   planner: {
     *     plan: ...,
     *     status: "writing"
     *   }
     * }
     */
    for (const [nodeName, nodeUpdate] of Object.entries(update)) {
      console.log(`[${nodeName}]`);

      console.dir(nodeUpdate, {
        depth: null,

        colors: true,
      });

      console.log();
    }
  }

  console.log("=== 最终完整 State ===\n");

  /**
   * FakeStructuredModel 的响应已经被 stream 消费完。
   *
   * 因此不能让 streamGraph 再次 invoke，
   * 必须创建新的 Model 和 Graph。
   */
  const invokeGraph = createResearchGraph({
    model: createDemoModel(),
    researchTool: new DemoResearchTool(),
    executionGuard: noOpExecutionGuard,
  });

  const result = await invokeGraph.invoke(input);

  /**
   * invoke 返回所有节点执行结束后的完整 State。
   */
  console.dir(
    {
      runId: result.runId,
      status: result.status,
      startedAt: result.startedAt,
      deadlineAt: result.deadlineAt,
      searchCount: result.searchCount,
      completedQuestionIds: result.completedQuestionIds,

      revisionCount: result.revisionCount,

      visitedNodes: result.visitedNodes,

      findings: result.findings,

      publishedReport: result.publishedReport,

      qualityWarning: result.qualityWarning,
    },
    {
      depth: null,

      colors: true,
    },
  );
};

main().catch((error: unknown) => {
  console.error("运行最小 Agent 示例失败：", error);

  process.exitCode = 1;
});
