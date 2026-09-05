import type { Metadata } from "next";
import { RunTimeline } from "@/components/run-timeline";

export const metadata: Metadata = { title: "调研运行状态" };

export default async function RunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return (
    <main className="page-shell detail-page" id="main-content">
      <RunTimeline runId={runId} />
    </main>
  );
}
