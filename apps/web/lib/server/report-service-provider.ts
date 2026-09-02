import { EvidenceRepository, ReportRepository } from "@insightforge/db";
import { getDatabaseConnection } from "./database";
import { PublicReportService } from "./report-service";

let cachedService: PublicReportService | undefined;

export const getPublicReportService = (): PublicReportService => {
  if (cachedService) return cachedService;
  const { db } = getDatabaseConnection();
  cachedService = new PublicReportService(
    new ReportRepository(db),
    new EvidenceRepository(db),
  );
  return cachedService;
};
