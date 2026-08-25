import { FakeStructuredModel } from "@insightforge/testkit";
import { describe, expect, it } from "vitest";

import {
  extractEvidenceCandidates,
  groundEvidenceCandidates,
} from "./evidence-extractor";
import type { EvidenceCandidateDraft } from "./evidence-candidate";
import type { ResearchFinding } from "./tools/research-tool";

const quote = "Recommendation systems and data infrastructure overview.";

const findings: ResearchFinding[] = [
  {
    questionId: "q1",
    summary: "ByteDance technology research.",
    sources: [
      {
        title: "ByteDance Technology Overview",
        url: "https://example.com/technology",
        snippet: `Introduction. ${quote} More context.`,
      },
    ],
  },
  {
    questionId: "q2",
    summary: "ByteDance business research.",
    sources: [
      {
        title: "ByteDance Business Overview",
        url: "https://example.com/business",
        snippet: "The company operates several digital products.",
      },
    ],
  },
];

const validDraft: EvidenceCandidateDraft = {
  questionId: "q1",
  claim: "ByteDance has recommendation and data infrastructure capabilities.",
  sourceUrl: "https://example.com/technology",
  quote,
  confidence: 0.9,
};

describe("groundEvidenceCandidates", () => {
  it("adds the trusted source title to a grounded candidate", () => {
    expect(groundEvidenceCandidates([validDraft], findings)).toEqual([
      {
        ...validDraft,
        evidenceId: "E1",
        sourceTitle: "ByteDance Technology Overview",
      },
    ]);
  });

  it.each([
    [
      "an unknown URL",
      { sourceUrl: "https://attacker.example.com/fabricated" },
    ],
    ["a fabricated quote", { quote: "This sentence is not in the source." }],
    ["a URL belonging to another question", { questionId: "q2" }],
  ])("rejects %s", (_name, overrides) => {
    expect(
      groundEvidenceCandidates([{ ...validDraft, ...overrides }], findings),
    ).toEqual([]);
  });

  it("deduplicates candidates and keeps at most two per question", () => {
    const second = {
      ...validDraft,
      claim: "ByteDance operates large-scale infrastructure.",
    };
    const third = {
      ...validDraft,
      claim: "ByteDance uses data platforms.",
    };

    const result = groundEvidenceCandidates(
      [validDraft, validDraft, second, third],
      findings,
    );

    expect(result).toHaveLength(2);
    expect(result.map((candidate) => candidate.claim)).toEqual([
      validDraft.claim,
      second.claim,
    ]);
  });
});

describe("extractEvidenceCandidates", () => {
  it("makes one structured model call and returns only grounded evidence", async () => {
    const model = new FakeStructuredModel([
      {
        candidates: [
          validDraft,
          {
            ...validDraft,
            quote: "Fabricated quote",
          },
        ],
      },
    ]);

    const result = await extractEvidenceCandidates({
      model,
      questions: [
        { id: "q1", question: "What technology does ByteDance use?" },
        { id: "q2", question: "What products does ByteDance operate?" },
      ],
      findings,
    });

    expect(result.candidates).toEqual([
      {
        ...validDraft,
        evidenceId: "E1",
        sourceTitle: "ByteDance Technology Overview",
      },
    ]);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.operation).toBe("extract-evidence");

    const modelInput = JSON.parse(
      model.calls[0]?.messages.find((message) => message.role === "user")
        ?.content ?? "{}",
    ) as {
      questions?: Array<{
        questionId: string;
        sources: Array<{ content: string }>;
      }>;
    };
    expect(modelInput.questions).toHaveLength(2);
    expect(modelInput.questions?.[0]?.sources[0]?.content).toBe(
      findings[0]?.sources[0]?.snippet,
    );
  });

  it("stops the workflow when every model candidate is ungrounded", async () => {
    const model = new FakeStructuredModel([
      {
        candidates: [
          {
            ...validDraft,
            quote: "Fabricated quote",
          },
        ],
      },
    ]);

    await expect(
      extractEvidenceCandidates({
        model,
        questions: [
          { id: "q1", question: "What technology does ByteDance use?" },
        ],
        findings,
      }),
    ).rejects.toThrow("GROUNDED_EVIDENCE_REQUIRED");
  });
});
