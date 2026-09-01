/**
 * 这个文件只负责描述数据库结构：
表名和列名
PostgreSQL 枚举
主键、外键
默认值
唯一约束
Check 约束
普通索引
pgvector 向量列和 HNSW 索引
*/

import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  index,
  check,
  varchar,
  vector,
  uuid,
  numeric,
  jsonb,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { JsonObject } from "@insightforge/domain";

/**
 * 为什么数据库还要定义一遍枚举？
Zod 防止非法数据进入应用
PostgreSQL 防止非法数据直接进入数据库
即使以后有脚本绕过 API，数据库仍能保护数据完整性
*/
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

export const evidenceSourceTypeEnum = pgEnum("evidence_source_type", [
  "web",
  "document",
]);

export const evidenceSourceCategoryEnum = pgEnum("evidence_source_category", [
  "official",
  "trusted_news",
  "secondary",
  "unknown",
]);

export const documentTypeEnum = pgEnum("document_type", [
  "pdf",
  "docx",
  "markdown",
  "text",
]);

export const documentStatusEnum = pgEnum("document_status", [
  "pending",
  "processing",
  "ready",
  "failed",
]);

export const reportVersionStatusEnum = pgEnum("report_version_status", [
  "draft",
  "published",
]);

export const users = pgTable(
  "users",
  {
    id: varchar("id", { length: 128 }).primaryKey(),
    email: varchar("email", { length: 320 }),
    name: varchar("name", { length: 120 }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const researchRuns = pgTable(
  "research_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: varchar("owner_id", { length: 128 })
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
      }),
    company: varchar("company", { length: 120 }).notNull(),
    focus: researchFocusEnum("focus").notNull(),
    depth: researchDepthEnum("depth").notNull(),
    status: runStatusEnum("status").default("queued").notNull(),
    tokenUsage: integer("token_usage").default(0).notNull(),
    estimatedCostCny: numeric("estimated_cost_cny", { precision: 12, scale: 6 })
      .default("0")
      .notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("research_runs_owner_id_idx").on(table.ownerId),
    index("research_runs_status_idx").on(table.status),
    index("research_runs_created_at_idx").on(table.ownerId, table.createdAt),
    check(
      "research_runs_token_usage_nonnegative",
      sql`${table.tokenUsage} >= 0`,
    ),
    check(
      "research_runs_estimated_cost_cny_nonnegative",
      sql`${table.estimatedCostCny} >= 0`,
    ),
  ],
);

export const runCheckpoints = pgTable(
  "run_checkpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, {
        onDelete: "cascade",
      }),
    checkpointKey: varchar("checkpoint_key", { length: 128 }).notNull(),
    state: jsonb("state").$type<JsonObject>().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("run_checkpoints_run_id_idx").on(table.runId),
    uniqueIndex("run_checkpoints_run_key_unique").on(
      table.runId,
      table.checkpointKey,
    ),
  ],
);

/** 保存网页或用户上传文档的元数据 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, {
        onDelete: "cascade",
      }),
    ownerId: varchar("owner_id", { length: 128 })
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
      }),
    title: varchar("title", { length: 500 }).notNull(),
    originalName: varchar("original_name", { length: 500 }).notNull(),
    documentType: documentTypeEnum("document_type").notNull(),
    status: documentStatusEnum("status").default("pending").notNull(),
    errorCode: varchar("error_code", { length: 80 }),
    sourceUrl: text("source_url"),
    mimeType: varchar("mime_type", { length: 120 }).notNull(),
    fileSize: integer("file_size").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("documents_run_id_idx").on(table.runId),
    index("documents_owner_id_idx").on(table.ownerId),
    uniqueIndex("documents_owner_hash_unique").on(
      table.ownerId,
      table.contentHash,
    ),
    check(
      "documents_content_hash_format",
      sql`${table.contentHash} ~ '^[A-Fa-f0-9]{64}$'`,
    ),
    check("documents_file_size_positive", sql`${table.fileSize} > 0`),
    check(
      "documents_status_error_consistency",
      sql`(${table.status} = 'failed' AND ${table.errorCode} IS NOT NULL) OR (${table.status} <> 'failed' AND ${table.errorCode} IS NULL)`,
    ),
  ],
);

/**
 * 文档实体按 owner + contentHash 复用；该关联表描述哪些 Run 可以使用它。
 */
export const runDocuments = pgTable(
  "run_documents",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ownerId: varchar("owner_id", { length: 128 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("run_documents_run_document_unique").on(
      table.runId,
      table.documentId,
    ),
    index("run_documents_owner_run_idx").on(table.ownerId, table.runId),
  ],
);

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, {
        onDelete: "cascade",
      }),
    ownerId: varchar("owner_id", { length: 128 })
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
      }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count").default(0).notNull(),
    // 保存结构可变、可查询的 JSON 数据
    metadata: jsonb("metadata").$type<JsonObject>().default({}).notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("document_chunks_owner_id_idx").on(table.ownerId),
    index("document_chunks_document_id_idx").on(table.documentId),
    uniqueIndex("document_chunks_document_index_unique").on(
      table.documentId,
      table.chunkIndex,
    ),
    index("document_chunks_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    index("document_chunks_content_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.content})`,
    ),
    check(
      "document_chunks_token_count_nonnegative",
      sql`${table.tokenCount} >= 0`,
    ),
    check(
      "document_chunks_chunk_index_nonnegative",
      sql`${table.chunkIndex} >= 0`,
    ),
  ],
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, {
        onDelete: "cascade",
      }),
    ownerId: varchar("owner_id", { length: 128 })
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
      }),
    claim: text("claim").notNull(),
    sourceType: evidenceSourceTypeEnum("source_type").notNull(),
    sourceCategory: evidenceSourceCategoryEnum("source_category")
      .default("unknown")
      .notNull(),
    sourceUrl: text("source_url"),
    sourceTitle: varchar("source_title", { length: 500 }),
    publisher: varchar("publisher", { length: 300 }),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
    retrievedAt: timestamp("retrieved_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    quote: text("quote").notNull(),
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    page: integer("page"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("evidence_owner_id_idx").on(table.ownerId),
    index("evidence_run_id_idx").on(table.runId),
    index("evidence_document_id_idx").on(table.documentId),
    uniqueIndex("evidence_run_hash_unique").on(table.runId, table.contentHash),
    check(
      "evidence_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check(
      "evidence_content_hash_format",
      sql`${table.contentHash} ~ '^[A-Fa-f0-9]{64}$'`,
    ),
    check(
      "evidence_page_positive",
      sql`${table.page} IS NULL OR ${table.page} > 0`,
    ),
    check(
      "evidence_source_consistency",
      sql`
        (
          ${table.sourceType} = 'web'
          AND ${table.sourceUrl} IS NOT NULL
          AND ${table.documentId} IS NULL
        )
        OR
        (
          ${table.sourceType} = 'document'
          AND ${table.documentId} IS NOT NULL
        )
      `,
    ),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, {
        onDelete: "cascade",
      }),

    ownerId: varchar("owner_id", {
      length: 128,
    })
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
      }),

    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("reports_run_id_unique").on(table.runId),

    index("reports_owner_id_idx").on(table.ownerId),
  ],
);

export const reportVersions = pgTable(
  "report_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, {
        onDelete: "cascade",
      }),

    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, {
        onDelete: "cascade",
      }),

    ownerId: varchar("owner_id", {
      length: 128,
    })
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
      }),

    version: integer("version").notNull(),

    content: jsonb("content").$type<JsonObject>().notNull(),

    status: reportVersionStatusEnum("status").notNull(),

    qualityWarning: text("quality_warning"),

    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),

    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    uniqueIndex("report_versions_report_version_unique").on(
      table.reportId,
      table.version,
    ),

    index("report_versions_owner_id_idx").on(table.ownerId),

    index("report_versions_report_id_idx").on(table.reportId),

    check("report_versions_version_positive", sql`${table.version} > 0`),

    check(
      "report_versions_publish_consistency",
      sql`
        (
          ${table.status} = 'draft'
          AND ${table.publishedAt} IS NULL
        )
        OR
        (
          ${table.status} = 'published'
          AND ${table.publishedAt} IS NOT NULL
        )
      `,
    ),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, {
        onDelete: "cascade",
      }),

    ownerId: varchar("owner_id", {
      length: 128,
    })
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
      }),

    provider: varchar("provider", {
      length: 80,
    }).notNull(),

    model: varchar("model", {
      length: 160,
    }),

    operation: varchar("operation", {
      length: 80,
    }).notNull(),

    inputTokens: integer("input_tokens").default(0).notNull(),

    outputTokens: integer("output_tokens").default(0).notNull(),

    estimatedCostCny: numeric("estimated_cost_cny", {
      precision: 12,
      scale: 6,
    })
      .default("0")
      .notNull(),

    metadata: jsonb("metadata").$type<JsonObject>().default({}).notNull(),

    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("usage_events_owner_id_idx").on(table.ownerId),

    index("usage_events_run_id_idx").on(table.runId),

    index("usage_events_created_at_idx").on(table.createdAt),

    check(
      "usage_events_input_tokens_nonnegative",
      sql`${table.inputTokens} >= 0`,
    ),

    check(
      "usage_events_output_tokens_nonnegative",
      sql`${table.outputTokens} >= 0`,
    ),

    check("usage_events_cost_nonnegative", sql`${table.estimatedCostCny} >= 0`),
  ],
);
