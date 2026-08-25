import type {
  ModelInput,
  ModelResult,
  StructuredModel,
} from "@insightforge/domain";
import { FakeStructuredModel } from "@insightforge/testkit";
import type { ZodType } from "zod";
import { describe, expect, it } from "vitest";

import { createResearchGraph } from "./graph";
import type {
  ResearchFinding,
  ResearchTool,
  ResearchToolInput,
} from "./tools/research-tool";

const plan = {
  objective: "分析 ByteDance 的技术能力",
  questions: [
    {
      id: "q1",
      question: "ByteDance 的核心技术能力是什么？",
      rationale: "用于判断公司的技术竞争力",
    },
  ],
};

const firstDraft = {
  title: "ByteDance 技术调研",
  executiveSummary: "ByteDance 建立了数据和算法驱动的技术体系。",
  executiveSummaryEvidenceIds: ["E1"],
  sections: [
    { heading: "核心技术", markdown: "第一版报告内容。", evidenceIds: ["E1"] },
  ],
};

const revisedDraft = {
  title: "ByteDance 技术调研（修订版）",
  executiveSummary: "ByteDance 的推荐、数据平台和基础设施形成协同。",
  executiveSummaryEvidenceIds: ["E1"],
  sections: [
    {
      heading: "核心技术",
      markdown: "根据评审意见补充后的报告内容。",
      evidenceIds: ["E1"],
    },
  ],
};

const passedReview = { passed: true, score: 90, issues: [] };
const failedReview = {
  passed: false,
  score: 60,
  issues: ["缺少基础设施能力分析"],
};

const evidenceExtractionOutput = {
  candidates: [
    {
      questionId: "q1",
      claim: "ByteDance 建设了推荐系统和数据基础设施。",
      sourceUrl: "https://example.com/technology",
      quote: "Recommendation systems and data infrastructure overview.",
      confidence: 0.9,
    },
  ],
};

const input = {
  company: "ByteDance",
  focus: "technology" as const,
  depth: "quick" as const,
};

const createFinding = (input: ResearchToolInput): ResearchFinding => ({
  questionId: input.questionId,
  summary: `${input.company} 在推荐算法和数据基础设施方面持续投入。`,
  sources: [
    {
      title: `${input.company} Technology Overview`,
      url: "https://example.com/technology",
      snippet: "Recommendation systems and data infrastructure overview.",
    },
  ],
});

class FakeResearchTool implements ResearchTool {
  readonly calls: ResearchToolInput[] = [];

  constructor(
    private readonly implementation: (
      input: ResearchToolInput,
    ) => Promise<ResearchFinding> = async (toolInput) =>
      createFinding(toolInput),
  ) {}

  async research(input: ResearchToolInput): Promise<ResearchFinding> {
    this.calls.push(input);
    return this.implementation(input);
  }
}

describe("createResearchGraph", () => {
  it("publishes directly when the first review passes", async () => {
    const model = new FakeStructuredModel([
      plan,
      evidenceExtractionOutput,
      firstDraft,
      passedReview,
    ]);
    const researchTool = new FakeResearchTool();
    const graph = createResearchGraph({ model, researchTool });

    const result = await graph.invoke(input);

    expect(result.status).toBe("completed");
    expect(result.publishedReport).toEqual(firstDraft);
    expect(result.qualityWarning).toBeNull();
    expect(result.revisionCount).toBe(0);
    expect(result.visitedNodes).toEqual([
      "planner",
      "researcher",
      "evidenceExtractor",
      "writer",
      "citationValidator",
      "reviewer",
      "publisher",
    ]);
    expect(model.calls.map((call) => call.operation)).toEqual([
      "plan-research",
      "extract-evidence",
      "write-report",
      "review-report",
    ]);
    expect(researchTool.calls).toEqual([
      {
        company: "ByteDance",
        focus: "technology",
        depth: "quick",
        questionId: "q1",
        question: "ByteDance 的核心技术能力是什么？",
      },
    ]);
  });

  it("routes back to writer once when the first review fails", async () => {
    const model = new FakeStructuredModel([
      plan,
      evidenceExtractionOutput,
      firstDraft,
      failedReview,
      revisedDraft,
      passedReview,
    ]);
    const graph = createResearchGraph({
      model,
      researchTool: new FakeResearchTool(),
    });

    const result = await graph.invoke(input);

    expect(result.status).toBe("completed");
    expect(result.publishedReport).toEqual(revisedDraft);
    expect(result.qualityWarning).toBeNull();
    expect(result.revisionCount).toBe(1);
    expect(result.visitedNodes).toEqual([
      "planner",
      "researcher",
      "evidenceExtractor",
      "writer",
      "citationValidator",
      "reviewer",
      "writer",
      "citationValidator",
      "reviewer",
      "publisher",
    ]);
    expect(model.calls.map((call) => call.operation)).toEqual([
      "plan-research",
      "extract-evidence",
      "write-report",
      "review-report",
      "revise-report",
      "review-report",
    ]);
  });

  it("repairs invalid citations once before calling reviewer", async () => {
    const invalidCitationDraft = {
      ...firstDraft,
      executiveSummaryEvidenceIds: ["E99"],
    };
    const model = new FakeStructuredModel([
      plan,
      evidenceExtractionOutput,
      invalidCitationDraft,
      revisedDraft,
      passedReview,
    ]);
    const graph = createResearchGraph({
      model,
      researchTool: new FakeResearchTool(),
    });

    const result = await graph.invoke(input);

    expect(result.status).toBe("completed");
    expect(result.publishedReport).toEqual(revisedDraft);
    expect(result.citationRevisionCount).toBe(1);
    expect(result.revisionCount).toBe(0);
    expect(result.visitedNodes).toEqual([
      "planner",
      "researcher",
      "evidenceExtractor",
      "writer",
      "citationValidator",
      "writer",
      "citationValidator",
      "reviewer",
      "publisher",
    ]);
    expect(model.calls.map((call) => call.operation)).toEqual([
      "plan-research",
      "extract-evidence",
      "write-report",
      "revise-report",
      "review-report",
    ]);
  });

  it("stops when citations are still invalid after one repair", async () => {
    const invalidCitationDraft = {
      ...firstDraft,
      executiveSummaryEvidenceIds: ["E99"],
    };
    const model = new FakeStructuredModel([
      plan,
      evidenceExtractionOutput,
      invalidCitationDraft,
      invalidCitationDraft,
    ]);
    const graph = createResearchGraph({
      model,
      researchTool: new FakeResearchTool(),
    });

    await expect(graph.invoke(input)).rejects.toThrow(
      "REPORT_CITATIONS_INVALID",
    );
    expect(model.calls.map((call) => call.operation)).toEqual([
      "plan-research",
      "extract-evidence",
      "write-report",
      "revise-report",
    ]);
  });

  it("keeps review and citation revision budgets independent", async () => {
    const invalidCitationRevision = {
      ...revisedDraft,
      executiveSummaryEvidenceIds: ["E99"],
    };
    const citationFixedDraft = {
      ...revisedDraft,
      executiveSummaryEvidenceIds: ["E1"],
    };
    const model = new FakeStructuredModel([
      plan,
      evidenceExtractionOutput,
      firstDraft,
      failedReview,
      invalidCitationRevision,
      citationFixedDraft,
      passedReview,
    ]);
    const graph = createResearchGraph({
      model,
      researchTool: new FakeResearchTool(),
    });

    const result = await graph.invoke(input);

    expect(result.status).toBe("completed");
    expect(result.revisionCount).toBe(1);
    expect(result.citationRevisionCount).toBe(1);
    expect(result.publishedReport).toEqual(citationFixedDraft);
  });

  it("publishes with a warning instead of revising forever", async () => {
    const model = new FakeStructuredModel([
      plan,
      evidenceExtractionOutput,
      firstDraft,
      failedReview,
      revisedDraft,
      failedReview,
    ]);
    const graph = createResearchGraph({
      model,
      researchTool: new FakeResearchTool(),
    });

    const result = await graph.invoke(input);

    expect(result.publishedReport).toEqual(revisedDraft);
    expect(result.revisionCount).toBe(1);
    expect(result.qualityWarning).toContain("人工复核");
    expect(
      result.visitedNodes.filter((node) => node === "writer"),
    ).toHaveLength(2);
    expect(model.calls).toHaveLength(6);
  });

  it("rejects a model response that does not match the node schema", async () => {
    const model = new FakeStructuredModel([{ objective: "缺少 questions" }]);
    const graph = createResearchGraph({
      model,
      researchTool: new FakeResearchTool(),
    });

    await expect(graph.invoke(input)).rejects.toThrow();
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.operation).toBe("plan-research");
  });

  it("accumulates token usage and cost from all model nodes", async () => {
    const model = new UsageStructuredModel([
      plan,
      evidenceExtractionOutput,
      firstDraft,
      passedReview,
    ]);
    const graph = createResearchGraph({
      model,
      researchTool: new FakeResearchTool(),
    });

    const result = await graph.invoke(input);

    expect(result.tokenUsage).toBe(12);
    expect(result.estimatedCostCny).toBeCloseTo(0.4);
  });

  it("researches every planned question and gives only grounded evidence to model nodes", async () => {
    const twoQuestionPlan = {
      ...plan,
      questions: [
        plan.questions[0],
        {
          id: "q2",
          question: "ByteDance 如何建设数据基础设施？",
          rationale: "用于判断技术能力能否规模化",
        },
      ],
    };
    const model = new FakeStructuredModel([
      twoQuestionPlan,
      evidenceExtractionOutput,
      firstDraft,
      passedReview,
    ]);
    const researchTool = new FakeResearchTool();
    const graph = createResearchGraph({ model, researchTool });

    const result = await graph.invoke(input);

    expect(researchTool.calls.map((call) => call.questionId)).toEqual([
      "q1",
      "q2",
    ]);
    expect(result.findings.map((finding) => finding.questionId)).toEqual([
      "q1",
      "q2",
    ]);

    const writerCall = model.calls.find(
      (call) => call.operation === "write-report",
    );
    expect(writerCall).toBeDefined();
    const writerInput = JSON.parse(
      writerCall?.messages.find((message) => message.role === "user")
        ?.content ?? "{}",
    ) as {
      findings?: ResearchFinding[];
      evidenceCandidates?: unknown[];
    };
    expect(writerInput.findings).toBeUndefined();
    expect(writerInput.evidenceCandidates).toEqual(result.evidenceCandidates);

    const reviewerCall = model.calls.find(
      (call) => call.operation === "review-report",
    );
    const reviewerInput = JSON.parse(
      reviewerCall?.messages.find((message) => message.role === "user")
        ?.content ?? "{}",
    ) as {
      findings?: ResearchFinding[];
      evidenceCandidates?: unknown[];
    };
    expect(reviewerInput.findings).toBeUndefined();
    expect(reviewerInput.evidenceCandidates).toEqual(result.evidenceCandidates);
  });

  it("stops before writer when model evidence cannot be grounded", async () => {
    const model = new FakeStructuredModel([
      plan,
      {
        candidates: [
          {
            ...evidenceExtractionOutput.candidates[0],
            quote: "Fabricated quote",
          },
        ],
      },
    ]);
    const graph = createResearchGraph({
      model,
      researchTool: new FakeResearchTool(),
    });

    await expect(graph.invoke(input)).rejects.toThrow(
      "GROUNDED_EVIDENCE_REQUIRED",
    );
    expect(model.calls.map((call) => call.operation)).toEqual([
      "plan-research",
      "extract-evidence",
    ]);
  });

  it.each([
    { depth: "quick" as const, expectedQuestionCount: 3 },
    { depth: "deep" as const, expectedQuestionCount: 6 },
  ])(
    "limits $depth plans to $expectedQuestionCount questions before searching",
    async ({ depth, expectedQuestionCount }) => {
      const eightQuestionPlan = {
        ...plan,
        questions: Array.from({ length: 8 }, (_, index) => ({
          id: `q${index + 1}`,
          question: `第 ${index + 1} 个调研问题`,
          rationale: `第 ${index + 1} 个问题的原因`,
        })),
      };
      const model = new FakeStructuredModel([
        eightQuestionPlan,
        evidenceExtractionOutput,
        firstDraft,
        passedReview,
      ]);
      const researchTool = new FakeResearchTool();
      const graph = createResearchGraph({ model, researchTool });

      const result = await graph.invoke({ ...input, depth });

      expect(result.plan?.questions).toHaveLength(expectedQuestionCount);
      expect(researchTool.calls).toHaveLength(expectedQuestionCount);
      expect(researchTool.calls.map((call) => call.questionId)).toEqual(
        Array.from(
          { length: expectedQuestionCount },
          (_, index) => `q${index + 1}`,
        ),
      );
    },
  );

  it("stops before writer when the research tool fails", async () => {
    const model = new FakeStructuredModel([plan]);
    const researchTool = new FakeResearchTool(async () => {
      throw new Error("SEARCH_UNAVAILABLE");
    });
    const graph = createResearchGraph({ model, researchTool });

    await expect(graph.invoke(input)).rejects.toThrow("SEARCH_UNAVAILABLE");
    expect(model.calls.map((call) => call.operation)).toEqual([
      "plan-research",
    ]);
  });

  it("rejects a finding associated with the wrong question", async () => {
    const model = new FakeStructuredModel([plan]);
    const researchTool = new FakeResearchTool(async (toolInput) => ({
      ...createFinding(toolInput),
      questionId: "another-question",
    }));
    const graph = createResearchGraph({ model, researchTool });

    await expect(graph.invoke(input)).rejects.toThrow(
      "RESEARCH_FINDING_QUESTION_MISMATCH",
    );
    expect(model.calls).toHaveLength(1);
  });
});

class UsageStructuredModel implements StructuredModel {
  readonly calls: ModelInput[] = [];

  constructor(private readonly responses: unknown[]) {}

  async generate<T>(
    schema: ZodType<T>,
    input: ModelInput,
  ): Promise<ModelResult<T>> {
    this.calls.push(input);

    if (this.responses.length === 0) {
      throw new Error(`No response queued for ${input.operation}`);
    }

    return {
      value: schema.parse(this.responses.shift()),
      usage: { inputTokens: 1, outputTokens: 2, costCny: 0.1 },
    };
  }
}
