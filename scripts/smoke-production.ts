import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PublicPublishedReportSchema } from "../packages/domain/src/index";
import { z } from "zod";

const DEFAULT_REPORT_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
] as const;

const HealthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("insightforge-web"),
  version: z.string().min(1),
  dependencies: z.object({
    database: z.object({ status: z.literal("up") }),
    redis: z.object({ status: z.literal("up") }),
  }),
});

const SmokeRunSchema = z.object({
  runId: z.uuid(),
  reportId: z.uuid(),
  status: z.literal("completed"),
  events: z.array(
    z.object({
      type: z.literal("status"),
      status: z.literal("completed"),
      stage: z.literal("completed"),
      progress: z.literal(100),
    }),
  ),
});

export interface ProductionSmokeOptions {
  baseUrl: string;
  smokeToken: string;
  reportIds?: readonly string[];
  fetchImpl?: typeof fetch;
}

const fetchJson = async (
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<unknown> => {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`SMOKE_HTTP_${response.status}:${new URL(url).pathname}`);
  return response.json();
};

export const runProductionSmoke = async ({
  baseUrl,
  smokeToken,
  reportIds = DEFAULT_REPORT_IDS,
  fetchImpl = fetch,
}: ProductionSmokeOptions) => {
  const origin = new URL(baseUrl);
  if (!/^https?:$/.test(origin.protocol))
    throw new Error("SMOKE_BASE_URL_INVALID");
  if (smokeToken.trim().length < 32)
    throw new Error("SMOKE_TEST_TOKEN_INVALID");

  const health = HealthSchema.parse(
    await fetchJson(fetchImpl, new URL("/api/health", origin).href),
  );
  const reports = [];
  for (const reportId of reportIds) {
    const report = PublicPublishedReportSchema.parse(
      await fetchJson(
        fetchImpl,
        new URL(`/api/reports/${encodeURIComponent(reportId)}`, origin).href,
      ),
    );
    for (const citation of report.citations) {
      const source = new URL(citation.sourceUrl);
      if (source.protocol !== "http:" && source.protocol !== "https:") {
        throw new Error("SMOKE_CITATION_URL_INVALID");
      }
    }
    reports.push(report.reportId);
  }

  const smokeRun = SmokeRunSchema.parse(
    await fetchJson(fetchImpl, new URL("/api/smoke/runs", origin).href, {
      method: "POST",
      headers: { authorization: `Bearer ${smokeToken}` },
    }),
  );
  if (!smokeRun.events.some((event) => event.status === "completed")) {
    throw new Error("SMOKE_TERMINAL_EVENT_MISSING");
  }
  PublicPublishedReportSchema.parse(
    await fetchJson(
      fetchImpl,
      new URL(`/api/reports/${smokeRun.reportId}`, origin).href,
    ),
  );
  return {
    status: "passed" as const,
    serviceVersion: health.version,
    demoReportsChecked: reports.length,
    smokeRunId: smokeRun.runId,
  };
};

const readArgument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const baseUrl =
    readArgument("--base-url") ?? process.env.INSIGHTFORGE_PUBLIC_URL;
  if (!baseUrl) throw new Error("INSIGHTFORGE_PUBLIC_URL_REQUIRED");
  const result = await runProductionSmoke({
    baseUrl,
    smokeToken: process.env.SMOKE_TEST_TOKEN ?? "",
  });
  console.log(JSON.stringify(result, null, 2));
}
