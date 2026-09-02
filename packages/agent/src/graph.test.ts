import type {
  CreateReportVersion,
  Evidence,
  ModelInput,
  ModelResult,
  ReportVersion,
  StructuredModel,
} from "@insightforge/domain";
import { REQUIRED_REPORT_SECTION_KEYS } from "@insightforge/domain";
import { FakeStructuredModel } from "@insightforge/testkit";
import { MemorySaver } from "@langchain/langgraph";
import type { ZodType } from "zod";
import { describe, expect, it, vi } from "vitest";

import { createResearchGraph as createProductionResearchGraph } from "./graph";
import type {
  ResearchFinding,
  ResearchTool,
  ResearchToolInput,
} from "./tools/research-tool";

const RUN_ID = "550e8400-e29b-41d4-a716-446655440000";
const EVIDENCE_ID = "650e8400-e29b-41d4-a716-446655440000";
const UNKNOWN_ID = "750e8400-e29b-41d4-a716-446655440000";

const createPersistedEvidence = (
  overrides: Partial<Evidence> = {},
): Evidence => ({
  id: EVIDENCE_ID,
  runId: RUN_ID,
  ownerId: "owner-1",
  claim: "ByteDance 建设了推荐系统和数据基础设施。",
  sourceType: "web",
  sourceCategory: "official",
  sourceUrl: "https://example.com/technology",
  sourceTitle: "ByteDance Technology Overview",
  publisher: null,
  publishedAt: null,
  retrievedAt: new Date("2026-08-25T00:00:00.000Z"),
  quote: "Recommendation systems and data infrastructure overview.",
  documentId: null,
  page: null,
  confidence: 0.9,
  contentHash: "a".repeat(64),
  ...overrides,
});

const input = {
  runId: RUN_ID,
  reportId: RUN_ID,
  ownerId: "owner-1",
  company: "ByteDance",
  focus: "technology" as const,
  depth: "quick" as const,
  startedAt: "2026-08-25T00:00:00.000Z",
  deadlineAt: "2026-08-25T00:05:00.000Z",
};

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

const createDraft = (title: string, citationId = EVIDENCE_ID) => ({
  title,
  executiveSummary: [
    {
      markdown: "ByteDance 建设了推荐系统和数据基础设施。",
      claimType: "fact" as const,
      citationIds: [citationId],
    },
  ],
  sections: REQUIRED_REPORT_SECTION_KEYS.map((key) => ({
    key,
    heading: key,
    blocks: [
      {
        markdown: `${key} 分析。`,
        claimType: "inference" as const,
        citationIds: [EVIDENCE_ID],
      },
    ],
  })),
});

const passedReview = {
  passed: true,
  score: 90,
  sectionCompleteness: 1,
  citationCoverage: 1,
  citationSupport: 0.95,
  conflictHandling: 0.9,
  issues: [],
};

const failedReview = {
  passed: false,
  score: 70,
  sectionCompleteness: 1,
  citationCoverage: 1,
  citationSupport: 0.7,
  conflictHandling: 0.8,
  issues: [
    {
      code: "WEAK_SUPPORT",
      severity: "error" as const,
      location: "executiveSummary.blocks[0]",
      message: "结论范围大于证据支持范围。",
      citationId: EVIDENCE_ID,
    },
  ],
};

const criticalReview = {
  ...failedReview,
  issues: [
    {
      code: "CONTRADICTED_BY_SOURCE",
      severity: "critical" as const,
      location: "executiveSummary.blocks[0]",
      message: "结论与引文相反。",
      citationId: EVIDENCE_ID,
    },
  ],
};

const createFinding = (toolInput: ResearchToolInput): ResearchFinding => ({
  questionId: toolInput.questionId,
  summary: "ByteDance 在推荐算法和数据基础设施方面持续投入。",
  sources: [
    {
      title: "ByteDance Technology Overview",
      url: "https://example.com/technology",
      snippet: "Recommendation systems and data infrastructure overview.",
    },
  ],
});

class FakeResearchTool implements ResearchTool {
  readonly calls: ResearchToolInput[] = [];
  async research(toolInput: ResearchToolInput): Promise<ResearchFinding> {
    this.calls.push(toolInput);
    return createFinding(toolInput);
  }
}

const createHarness = (responses: unknown[], checkpointer?: MemorySaver) => {
  const model = new FakeStructuredModel(responses);
  const evidenceStore = {
    upsert: vi.fn(async (value: Evidence): Promise<Evidence> => ({
      ...value,
      id: EVIDENCE_ID,
    })),
    listForRun: vi.fn(async (): Promise<Evidence[]> => [
      createPersistedEvidence(),
    ]),
  };
  const versions: ReportVersion[] = [];
  const reportStore = {
    createVersion: vi.fn(
      async (value: CreateReportVersion): Promise<ReportVersion> => {
        const version: ReportVersion = {
          id: value.id ?? crypto.randomUUID(),
          reportId: value.reportId,
          runId: value.runId,
          ownerId: value.ownerId,
          version: versions.length + 1,
          content: value.content,
          status: value.status,
          qualityWarning: value.qualityWarning,
          createdAt: new Date("2026-08-25T00:00:02.000Z"),
          publishedAt:
            value.status === "published"
              ? new Date("2026-08-25T00:00:03.000Z")
              : null,
        };
        versions.push(version);
        return version;
      },
    ),
  };
  const graph = createProductionResearchGraph({
    model,
    researchTool: new FakeResearchTool(),
    evidenceStore,
    reportStore,
    executionGuard: { assertNotCancelled: vi.fn() },
    checkpointer,
    now: () => new Date("2026-08-25T00:00:01.000Z"),
  });
  return { graph, model, evidenceStore, reportStore, versions };
};

describe("Task 7 research graph", () => {
  it("在 Writer 前保存 Evidence，并保存草稿和发布版本", async () => {
    const draft = createDraft("第一版");
    const harness = createHarness([
      plan,
      evidenceExtractionOutput,
      draft,
      passedReview,
    ]);

    const result = await harness.graph.invoke(input);

    expect(result.status).toBe("completed");
    expect(result.evidence[0]?.id).toBe(EVIDENCE_ID);
    expect(result.publishedReport).toEqual(draft);
    expect(result.visitedNodes).toEqual([
      "planner",
      "researcher",
      "evidenceExtractor",
      "evidencePersister",
      "writer",
      "citationValidator",
      "reviewer",
      "publisher",
    ]);
    expect(harness.evidenceStore.upsert).toHaveBeenCalledOnce();
    expect(harness.versions.map((version) => version.status)).toEqual([
      "draft",
      "published",
    ]);
    expect(harness.versions[0]?.id).toBeDefined();
    expect(harness.versions[1]?.id).toBeDefined();
  });

  it("Writer 只收到有界 Evidence 白名单，不收到 ownerId、findings 或候选证据", async () => {
    const harness = createHarness([
      plan,
      evidenceExtractionOutput,
      createDraft("第一版"),
      passedReview,
    ]);
    await harness.graph.invoke(input);

    const call = harness.model.calls.find(
      (item) => item.operation === "write-report",
    );
    const prompt = call?.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain(EVIDENCE_ID);
    expect(prompt).not.toContain("owner-1");
    expect(prompt).not.toContain("contentHash");
    expect(prompt).not.toContain("evidenceCandidates");
    expect(prompt).not.toContain("findings");
  });

  it("第一次评审失败时只修订一次，并为每次写作创建新草稿版本", async () => {
    const revised = createDraft("修订版");
    const harness = createHarness([
      plan,
      evidenceExtractionOutput,
      createDraft("第一版"),
      failedReview,
      revised,
      passedReview,
    ]);

    const result = await harness.graph.invoke(input);

    expect(result.revisionCount).toBe(1);
    expect(result.publishedReport).toEqual(revised);
    expect(harness.versions.map((version) => version.status)).toEqual([
      "draft",
      "draft",
      "published",
    ]);
  });

  it("确定性引用错误只允许修订一次", async () => {
    const harness = createHarness([
      plan,
      evidenceExtractionOutput,
      createDraft("错误引用", UNKNOWN_ID),
      createDraft("修订后仍错误", UNKNOWN_ID),
    ]);

    await expect(harness.graph.invoke(input)).rejects.toThrow(
      "REPORT_CITATIONS_INVALID",
    );
    expect(
      harness.model.calls.filter((call) => call.operation.includes("report")),
    ).toHaveLength(2);
    expect(harness.versions).toHaveLength(2);
  });

  it("一次修订后仍有严重事实支持错误时禁止发布", async () => {
    const harness = createHarness([
      plan,
      evidenceExtractionOutput,
      createDraft("第一版"),
      criticalReview,
      createDraft("修订版"),
      criticalReview,
    ]);

    await expect(harness.graph.invoke(input)).rejects.toThrow(
      "REPORT_CITATION_SUPPORT_INVALID",
    );
    expect(
      harness.versions.every((version) => version.status === "draft"),
    ).toBe(true);
  });

  it("非严重质量问题修订后仍未通过时发布并追加未解决问题", async () => {
    const harness = createHarness([
      plan,
      evidenceExtractionOutput,
      createDraft("第一版"),
      failedReview,
      createDraft("修订版"),
      failedReview,
    ]);

    const result = await harness.graph.invoke(input);

    expect(result.qualityWarning).toContain("人工复核");
    expect(
      result.publishedReport?.sections.some(
        (section) => section.key === "unresolved_issues",
      ),
    ).toBe(true);
    expect(harness.versions.at(-1)?.status).toBe("published");
  });

  it("Repository 返回其他身份的 Evidence 时立即停止", async () => {
    const harness = createHarness([plan, evidenceExtractionOutput]);
    harness.evidenceStore.upsert.mockImplementationOnce(async (value) => ({
      ...value,
      id: EVIDENCE_ID,
      ownerId: "another-owner",
    }));
    harness.evidenceStore.listForRun.mockResolvedValueOnce([
      createPersistedEvidence({ ownerId: "another-owner" }),
    ]);

    await expect(harness.graph.invoke(input)).rejects.toThrow(
      "PERSISTED_EVIDENCE_IDENTITY_CONFLICT",
    );
    expect(harness.reportStore.createVersion).not.toHaveBeenCalled();
  });

  it("使用 Checkpointer 时保存包含正式 Evidence 的完成状态", async () => {
    const checkpointer = new MemorySaver();
    const harness = createHarness(
      [plan, evidenceExtractionOutput, createDraft("第一版"), passedReview],
      checkpointer,
    );
    const config = { configurable: { thread_id: RUN_ID } };

    await harness.graph.invoke(input, config);
    const checkpoint = await checkpointer.getTuple(config);

    expect(checkpoint?.checkpoint.channel_values).toEqual(
      expect.objectContaining({
        reportId: RUN_ID,
        ownerId: "owner-1",
        evidence: [expect.objectContaining({ id: EVIDENCE_ID })],
        status: "completed",
      }),
    );
  });

  it("累加所有模型节点的 Token 与成本", async () => {
    const model = new UsageStructuredModel([
      plan,
      evidenceExtractionOutput,
      createDraft("第一版"),
      passedReview,
    ]);
    const base = createHarness([]);
    const graph = createProductionResearchGraph({
      model,
      researchTool: new FakeResearchTool(),
      evidenceStore: base.evidenceStore,
      reportStore: base.reportStore,
      executionGuard: { assertNotCancelled: vi.fn() },
      now: () => new Date("2026-08-25T00:00:01.000Z"),
    });

    const result = await graph.invoke(input);
    expect(result.tokenUsage).toBe(12);
    expect(result.estimatedCostCny).toBeCloseTo(0.4);
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
    const response = this.responses.shift();
    return {
      value: schema.parse(response),
      usage: { inputTokens: 1, outputTokens: 2, costCny: 0.1 },
    };
  }
}
