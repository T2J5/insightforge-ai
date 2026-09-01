CREATE TYPE "public"."document_status" AS ENUM('pending', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('pdf', 'docx', 'markdown', 'text');--> statement-breakpoint
DROP INDEX "documents_run_hash_unique";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "original_name" varchar(500);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "document_type" "document_type";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "status" "document_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "error_code" varchar(80);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "file_size" integer;--> statement-breakpoint
UPDATE "documents"
SET
  "original_name" = "title",
  "document_type" = CASE
    WHEN "mime_type" = 'application/pdf' THEN 'pdf'::"document_type"
    WHEN "mime_type" = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' THEN 'docx'::"document_type"
    WHEN "mime_type" = 'text/markdown' THEN 'markdown'::"document_type"
    ELSE 'text'::"document_type"
  END,
  "mime_type" = COALESCE("mime_type", 'text/plain'),
  "storage_key" = COALESCE("storage_key", 'legacy/' || "id"::text),
  "file_size" = 1,
  "status" = 'failed',
  "error_code" = 'LEGACY_DOCUMENT_REUPLOAD_REQUIRED';--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "mime_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "storage_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "original_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "document_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "file_size" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "document_chunks_content_fts_idx" ON "document_chunks" USING gin (to_tsvector('simple', "content"));--> statement-breakpoint
CREATE UNIQUE INDEX "documents_owner_hash_unique" ON "documents" USING btree ("owner_id","content_hash");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_file_size_positive" CHECK ("documents"."file_size" > 0);--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_status_error_consistency" CHECK (("documents"."status" = 'failed' AND "documents"."error_code" IS NOT NULL) OR ("documents"."status" <> 'failed' AND "documents"."error_code" IS NULL));
