import type { Metadata } from "next";
import { ReportView } from "@/components/report-view";

export const metadata: Metadata = { title: "企业调研报告" };

export default async function ReportPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  return (
    <main className="page-shell detail-page" id="main-content">
      <ReportView reportId={reportId} />
    </main>
  );
}
