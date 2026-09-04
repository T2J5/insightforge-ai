import type {
  ModelInput,
  ModelResult,
  StructuredModel,
} from "@insightforge/domain";
import type { ToolAuditEvent, ToolAuditRecorder } from "@insightforge/agent";
import type { ZodType } from "zod";

import type { Telemetry } from "./telemetry";
import { recordUsage, type UsageSink } from "./usage";

export class InstrumentedStructuredModel implements StructuredModel {
  constructor(
    private readonly inner: StructuredModel,
    private readonly telemetry: Telemetry,
    private readonly usageSink: UsageSink,
    private readonly modelName: string,
    private readonly runId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  generate<T>(schema: ZodType<T>, input: ModelInput): Promise<ModelResult<T>> {
    const runId = this.runId();
    const startedAt = this.now();
    return this.telemetry.withSpan(
      `model.${input.operation}`,
      { runId, operation: input.operation, model: this.modelName },
      async () => {
        const result = await this.inner.generate(schema, input);
        await recordUsage(
          {
            traceId: runId,
            runId,
            operation: input.operation,
            model: this.modelName,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            estimatedCostCny: result.usage.costCny,
            latencyMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
            cacheHit: false,
            retryCount: 0,
            occurredAt: this.now().toISOString(),
          },
          this.usageSink,
        );
        return result;
      },
      runId,
    );
  }
}

export class TelemetryToolAuditRecorder implements ToolAuditRecorder {
  constructor(
    private readonly sink: {
      record(event: ToolAuditEvent): Promise<void> | void;
    },
  ) {}
  async record(event: ToolAuditEvent): Promise<void> {
    await this.sink.record(event);
  }
}
