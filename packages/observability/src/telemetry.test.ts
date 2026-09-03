import { describe, expect, it } from "vitest";

import { Telemetry, type SpanEvent } from "./telemetry";

describe("Telemetry", () => {
  it("creates nested spans without logging sensitive input", async () => {
    const events: SpanEvent[] = [];
    let tick = 0;
    let sequence = 0;
    const telemetry = new Telemetry(
      {
        record(event) {
          events.push(event);
        },
      },
      () => new Date(1_000 + tick++ * 10),
      () => `id-${++sequence}`,
    );
    await telemetry.withSpan(
      "agent.node.writer",
      { runId: "run-1", node: "writer" },
      async () => {
        await telemetry.withSpan(
          "model.write-report",
          { model: "fake" },
          async () => "ok",
        );
      },
      "run-1",
    );
    expect(events).toHaveLength(4);
    expect(events[1]!.parentSpanId).toBe(events[0]!.spanId);
    expect(JSON.stringify(events)).not.toContain("prompt");
  });

  it("publishes a stable public error code", async () => {
    const events: SpanEvent[] = [];
    const telemetry = new Telemetry({
      record(event) {
        events.push(event);
      },
    });
    await expect(
      telemetry.withSpan("operation", {}, async () => {
        throw new Error("database password leaked");
      }),
    ).rejects.toThrow();
    expect(events.at(-1)?.errorCode).toBe("INTERNAL_ERROR");
  });
});
