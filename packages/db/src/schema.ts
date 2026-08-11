import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const researchFocusEnum = pgEnum("research_focus", [
  "comprehensive",
  "product",
  "technology",
  "business",
  "competition",
]);
export const researchDepthEnum = pgEnum("research_depth", ["quick", "deep"]);
export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "running",
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
]);
export const documentStatusEnum = pgEnum("document_status", [
  "uploaded",
  "processing",
  "ready",
  "failed",
]);
export const evidenceSourceTypeEnum = pgEnum("evidence_source_type", [
  "web",
  "document",
]);
export const reportVersionStatusEnum = pgEnum("report_version_status", [
  "draft",
  "published",
]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const researchRuns = pgTable(
  "research_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    company: text("company").notNull(),
    focus: researchFocusEnum("focus").notNull(),
    depth: researchDepthEnum("depth").notNull(),
    status: runStatusEnum("status").notNull().default("queued"),
    tokenUsage: integer("token_usage").notNull().default(0),
    estimatedCostCny: numeric("estimated_cost_cny", {
      precision: 12,
      scale: 4,
    })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("research_runs_owner_id_idx").on(table.ownerId)],
);

export const runCheckpoints = pgTable(
  "run_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    checkpointKey: text("checkpoint_key").notNull(),
    state: jsonb("state").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("run_checkpoints_run_key_uidx").on(
      table.runId,
      table.checkpointKey,
    ),
    index("run_checkpoints_run_id_idx").on(table.runId),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    storageKey: text("storage_key").notNull(),
    contentHash: text("content_hash").notNull(),
    status: documentStatusEnum("status").notNull().default("uploaded"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("documents_owner_id_idx").on(table.ownerId),
    uniqueIndex("documents_owner_hash_uidx").on(table.ownerId, table.contentHash),
  ],
);

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    content: text("content").notNull(),
    heading: text("heading"),
    page: integer("page"),
    chunkIndex: integer("chunk_index").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("document_chunks_owner_id_idx").on(table.ownerId),
    index("document_chunks_document_id_idx").on(table.documentId),
    index("document_chunks_embedding_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
  ],
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    claim: text("claim").notNull(),
    sourceType: evidenceSourceTypeEnum("source_type").notNull(),
    sourceUrl: text("source_url"),
    sourceTitle: text("source_title"),
    publisher: text("publisher"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    quote: text("quote").notNull(),
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    page: integer("page"),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (table) => [
    index("evidence_owner_id_idx").on(table.ownerId),
    index("evidence_run_id_idx").on(table.runId),
    uniqueIndex("evidence_run_hash_uidx").on(table.runId, table.contentHash),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("reports_owner_id_idx").on(table.ownerId),
    uniqueIndex("reports_run_id_uidx").on(table.runId),
  ],
);

export const reportVersions = pgTable(
  "report_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: jsonb("content").notNull().$type<Record<string, unknown>>(),
    status: reportVersionStatusEnum("status").notNull(),
    qualityWarning: text("quality_warning"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("report_versions_report_version_uidx").on(
      table.reportId,
      table.version,
    ),
    index("report_versions_report_id_idx").on(table.reportId),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    operation: text("operation").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCny: numeric("cost_cny", { precision: 12, scale: 4 }).notNull().default("0"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("usage_events_owner_id_idx").on(table.ownerId)],
);
