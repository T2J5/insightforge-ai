import {
  PublicPublishedReportSchema,
  RunProgressEventSchema,
  RunStatusSchema,
  type CreateRunRequest,
  type PublicPublishedReport,
  type RunProgressEvent,
} from "@insightforge/domain";
import { z } from "zod";

const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  issues: z
    .array(
      z.object({
        path: z.string(),
        message: z.string(),
        code: z.string(),
      }),
    )
    .default([]),
});

const CreatedRunSchema = z.object({
  runId: z.uuid(),
  status: RunStatusSchema,
});

export const RunSummarySchema = z.object({
  runId: z.uuid(),
  company: z.string(),
  focus: z.string(),
  depth: z.string(),
  status: RunStatusSchema,
  tokenUsage: z.number().nonnegative(),
  estimatedCostCny: z.number().nonnegative(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type RunSummary = z.infer<typeof RunSummarySchema>;

export class BrowserApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "BrowserApiError";
  }
}

const parseResponse = async <T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> => {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = ApiErrorSchema.safeParse(payload);
    throw new BrowserApiError(
      response.status,
      error.success ? error.data.code : "UNEXPECTED_RESPONSE",
      error.success ? error.data.message : "服务器返回了无法识别的响应。",
      Number(response.headers.get("Retry-After")) || undefined,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new BrowserApiError(
      response.status,
      "INVALID_SERVER_RESPONSE",
      "服务器返回的数据格式与页面版本不兼容，请刷新后重试。",
    );
  }
  return parsed.data;
};

export const createResearchRun = async (
  input: CreateRunRequest,
): Promise<z.infer<typeof CreatedRunSchema>> =>
  parseResponse(
    await fetch("/api/runs", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
    CreatedRunSchema,
  );

export const getResearchRun = async (runId: string): Promise<RunSummary> =>
  parseResponse(
    await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
      credentials: "same-origin",
      cache: "no-store",
    }),
    RunSummarySchema,
  );

export const cancelResearchRun = async (runId: string): Promise<void> => {
  await parseResponse(
    await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      credentials: "same-origin",
    }),
    CreatedRunSchema,
  );
};

export const getPublishedReport = async (
  reportId: string,
): Promise<PublicPublishedReport> =>
  parseResponse(
    await fetch(`/api/reports/${encodeURIComponent(reportId)}`, {
      cache: "no-store",
    }),
    PublicPublishedReportSchema,
  );

export const parseRunProgressEvent = (
  value: string,
): RunProgressEvent | null => {
  try {
    const parsed = RunProgressEventSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
