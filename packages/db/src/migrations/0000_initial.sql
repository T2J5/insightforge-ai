CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint
CREATE TYPE "public"."evidence_source_type" AS ENUM('web', 'document');--> statement-breakpoint
CREATE TYPE "public"."report_version_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."research_depth" AS ENUM('quick', 'deep');--> statement-breakpoint
CREATE TYPE "public"."research_focus" AS ENUM('comprehensive', 'product', 'technology', 'business', 'competition');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'awaiting_review', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"owner_id" varchar(128) NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_chunks_token_count_nonnegative" CHECK ("document_chunks"."token_count" >= 0),
	CONSTRAINT "document_chunks_chunk_index_nonnegative" CHECK ("document_chunks"."chunk_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_id" varchar(128) NOT NULL,
	"title" varchar(500) NOT NULL,
	"source_url" text,
	"mime_type" varchar(120),
	"content_hash" varchar(64) NOT NULL,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_content_hash_format" CHECK ("documents"."content_hash" ~ '^[A-Fa-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_id" varchar(128) NOT NULL,
	"claim" text NOT NULL,
	"source_type" "evidence_source_type" NOT NULL,
	"source_url" text,
	"source_title" varchar(500),
	"publisher" varchar(300),
	"published_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone NOT NULL,
	"quote" text NOT NULL,
	"document_id" uuid,
	"page" integer,
	"confidence" numeric(4, 3) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_confidence_range" CHECK ("evidence"."confidence" >= 0 AND "evidence"."confidence" <= 1),
	CONSTRAINT "evidence_content_hash_format" CHECK ("evidence"."content_hash" ~ '^[A-Fa-f0-9]{64}$'),
	CONSTRAINT "evidence_page_positive" CHECK ("evidence"."page" IS NULL OR "evidence"."page" > 0),
	CONSTRAINT "evidence_source_consistency" CHECK (
        (
          "evidence"."source_type" = 'web'
          AND "evidence"."source_url" IS NOT NULL
          AND "evidence"."document_id" IS NULL
        )
        OR
        (
          "evidence"."source_type" = 'document'
          AND "evidence"."document_id" IS NOT NULL
        )
      )
);
--> statement-breakpoint
CREATE TABLE "report_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_id" varchar(128) NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"status" "report_version_status" NOT NULL,
	"quality_warning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "report_versions_version_positive" CHECK ("report_versions"."version" > 0),
	CONSTRAINT "report_versions_publish_consistency" CHECK (
        (
          "report_versions"."status" = 'draft'
          AND "report_versions"."published_at" IS NULL
        )
        OR
        (
          "report_versions"."status" = 'published'
          AND "report_versions"."published_at" IS NOT NULL
        )
      )
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_id" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" varchar(128) NOT NULL,
	"company" varchar(120) NOT NULL,
	"focus" "research_focus" NOT NULL,
	"depth" "research_depth" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"token_usage" integer DEFAULT 0 NOT NULL,
	"estimated_cost_cny" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_runs_token_usage_nonnegative" CHECK ("research_runs"."token_usage" >= 0),
	CONSTRAINT "research_runs_estimated_cost_cny_nonnegative" CHECK ("research_runs"."estimated_cost_cny" >= 0)
);
--> statement-breakpoint
CREATE TABLE "run_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"checkpoint_key" varchar(128) NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_id" varchar(128) NOT NULL,
	"provider" varchar(80) NOT NULL,
	"model" varchar(160),
	"operation" varchar(80) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_cny" numeric(12, 6) DEFAULT '0' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_input_tokens_nonnegative" CHECK ("usage_events"."input_tokens" >= 0),
	CONSTRAINT "usage_events_output_tokens_nonnegative" CHECK ("usage_events"."output_tokens" >= 0),
	CONSTRAINT "usage_events_cost_nonnegative" CHECK ("usage_events"."estimated_cost_cny" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_checkpoints" ADD CONSTRAINT "run_checkpoints_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_chunks_owner_id_idx" ON "document_chunks" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "document_chunks_document_id_idx" ON "document_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_chunks_document_index_unique" ON "document_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_hnsw_idx" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "documents_run_id_idx" ON "documents" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "documents_owner_id_idx" ON "documents" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_run_hash_unique" ON "documents" USING btree ("run_id","content_hash");--> statement-breakpoint
CREATE INDEX "evidence_owner_id_idx" ON "evidence" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "evidence_run_id_idx" ON "evidence" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "evidence_document_id_idx" ON "evidence" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_run_hash_unique" ON "evidence" USING btree ("run_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "report_versions_report_version_unique" ON "report_versions" USING btree ("report_id","version");--> statement-breakpoint
CREATE INDEX "report_versions_owner_id_idx" ON "report_versions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "report_versions_report_id_idx" ON "report_versions" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_run_id_unique" ON "reports" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "reports_owner_id_idx" ON "reports" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "research_runs_owner_id_idx" ON "research_runs" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "research_runs_status_idx" ON "research_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "research_runs_created_at_idx" ON "research_runs" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "run_checkpoints_run_id_idx" ON "run_checkpoints" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_checkpoints_run_key_unique" ON "run_checkpoints" USING btree ("run_id","checkpoint_key");--> statement-breakpoint
CREATE INDEX "usage_events_owner_id_idx" ON "usage_events" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "usage_events_run_id_idx" ON "usage_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "usage_events_created_at_idx" ON "usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");