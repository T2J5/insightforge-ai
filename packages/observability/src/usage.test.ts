import { describe, expect, it } from "vitest";

import { estimateModelCostCny, recordUsage, type UsageEvent } from "./usage";

describe("model usage", () => {
  it("calculates input and output cost with hand-computed prices", () => {
    expect(
      estimateModelCostCny({
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        inputCostCnyPerMillionTokens: 2,
        outputCostCnyPerMillionTokens: 8,
      }),
    ).toBe(6);
  });

  it("records metadata without prompt or private content fields", async () => {
    const events: UsageEvent[] = [];
    await recordUsage(
      {
        traceId: "run-1",
        runId: "run-1",
        operation: "plan",
        model: "fake",
        inputTokens: 10,
        outputTokens: 20,
        estimatedCostCny: 0.01,
        latencyMs: 12,
        cacheHit: false,
        retryCount: 0,
        occurredAt: "2026-09-03T00:00:00.000Z",
      },
      {
        record(event) {
          events.push(event);
        },
      },
    );
    expect(events[0]).toMatchObject({ inputTokens: 10, outputTokens: 20 });
    expect(events[0]).not.toHaveProperty("prompt");
  });
});
