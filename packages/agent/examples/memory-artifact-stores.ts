import type {
  CreateReportVersion,
  Evidence,
  ReportVersion,
} from "@insightforge/domain";

export const DEMO_EVIDENCE_ID = "650e8400-e29b-41d4-a716-446655440000";

export const createMemoryArtifactStores = () => {
  const evidence: Evidence[] = [];
  const reports: ReportVersion[] = [];

  return {
    evidenceStore: {
      async upsert(input: Evidence): Promise<Evidence> {
        const existing = evidence.find(
          (item) =>
            item.runId === input.runId &&
            item.contentHash === input.contentHash,
        );
        if (existing) return existing;
        const saved = { ...input, id: DEMO_EVIDENCE_ID };
        evidence.push(saved);
        return saved;
      },
      async listForRun(runId: string): Promise<Evidence[]> {
        return evidence.filter((item) => item.runId === runId);
      },
    },
    reportStore: {
      async createVersion(input: CreateReportVersion): Promise<ReportVersion> {
        const existing = reports.find((item) => item.id === input.id);
        if (existing) return existing;
        const saved: ReportVersion = {
          ...input,
          id: input.id!,
          version: reports.length + 1,
          createdAt: new Date(),
          publishedAt: input.status === "published" ? new Date() : null,
        };
        reports.push(saved);
        return saved;
      },
    },
  };
};
