export interface UsageEvent {
  traceId: string;
  runId: string;
  operation: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostCny: number;
  latencyMs: number;
  cacheHit: boolean;
  retryCount: number;
  occurredAt: string;
}

export interface UsageSink {
  record(event: UsageEvent): Promise<void> | void;
}
export class JsonConsoleUsageSink implements UsageSink {
  record(event: UsageEvent): void {
    console.log(JSON.stringify({ level: "info", event: "usage", ...event }));
  }
}
const defaultSink = new JsonConsoleUsageSink();
export const recordUsage = (
  event: UsageEvent,
  sink: UsageSink = defaultSink,
): Promise<void> => Promise.resolve(sink.record(event));

export const estimateModelCostCny = (input: {
  inputTokens: number;
  outputTokens: number;
  inputCostCnyPerMillionTokens: number;
  outputCostCnyPerMillionTokens: number;
}): number => {
  for (const value of Object.values(input))
    if (!Number.isFinite(value) || value < 0)
      throw new Error("MODEL_USAGE_INVALID");
  return (
    (input.inputTokens / 1_000_000) * input.inputCostCnyPerMillionTokens +
    (input.outputTokens / 1_000_000) * input.outputCostCnyPerMillionTokens
  );
};
