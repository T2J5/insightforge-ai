import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type TelemetryAttribute = string | number | boolean | null;
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttribute>>;

export interface SpanEvent {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  phase: "started" | "succeeded" | "failed";
  timestamp: string;
  durationMs?: number;
  attributes: TelemetryAttributes;
  errorCode?: string;
}

export interface TelemetrySink {
  record(event: SpanEvent): Promise<void> | void;
}

export class JsonConsoleTelemetrySink implements TelemetrySink {
  record(event: SpanEvent): void {
    console.log(
      JSON.stringify({
        level: event.phase === "failed" ? "error" : "info",
        event: "trace",
        ...event,
      }),
    );
  }
}

interface SpanContext {
  traceId: string;
  spanId: string;
}
const contextStorage = new AsyncLocalStorage<SpanContext>();
const publicErrorCode = (error: unknown): string =>
  error &&
  typeof error === "object" &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message)
      ? error.message
      : "INTERNAL_ERROR";

export class Telemetry {
  constructor(
    private readonly sink: TelemetrySink = new JsonConsoleTelemetrySink(),
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID,
  ) {}

  currentTraceId(): string | undefined {
    return contextStorage.getStore()?.traceId;
  }

  async withSpan<T>(
    name: string,
    attributes: TelemetryAttributes,
    fn: () => Promise<T>,
    traceId?: string,
  ): Promise<T> {
    const parent = contextStorage.getStore();
    const spanId = this.id();
    const resolvedTraceId = traceId ?? parent?.traceId ?? this.id();
    const startedAt = this.now();
    const base = {
      traceId: resolvedTraceId,
      spanId,
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      name,
      attributes,
    };
    await this.sink.record({
      ...base,
      phase: "started",
      timestamp: startedAt.toISOString(),
    });
    try {
      const value = await contextStorage.run(
        { traceId: resolvedTraceId, spanId },
        fn,
      );
      const endedAt = this.now();
      await this.sink.record({
        ...base,
        phase: "succeeded",
        timestamp: endedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
      });
      return value;
    } catch (error) {
      const endedAt = this.now();
      await this.sink.record({
        ...base,
        phase: "failed",
        timestamp: endedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        errorCode: publicErrorCode(error),
      });
      throw error;
    }
  }
}

const defaultTelemetry = new Telemetry();
export const withSpan = <T>(
  name: string,
  attributes: TelemetryAttributes,
  fn: () => Promise<T>,
  traceId?: string,
): Promise<T> => defaultTelemetry.withSpan(name, attributes, fn, traceId);
