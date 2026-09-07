import { NextResponse } from "next/server";

import { getDatabaseConnection } from "@/lib/server/database";
import { createHealthReport } from "@/lib/server/health-service";
import { getProducerRedis } from "@/lib/server/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (): Promise<NextResponse> => {
  const report = await createHealthReport({
    checkDatabase: async () => {
      await getDatabaseConnection().client`select 1`;
    },
    checkRedis: async () => {
      await getProducerRedis().ping();
    },
  });
  return NextResponse.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
};
