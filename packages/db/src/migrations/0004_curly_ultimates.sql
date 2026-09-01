CREATE TABLE "run_documents" (
	"run_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"owner_id" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "run_documents" ("run_id", "document_id", "owner_id")
SELECT "run_id", "id", "owner_id" FROM "documents";--> statement-breakpoint
ALTER TABLE "run_documents" ADD CONSTRAINT "run_documents_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_documents" ADD CONSTRAINT "run_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_documents" ADD CONSTRAINT "run_documents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_documents_run_document_unique" ON "run_documents" USING btree ("run_id","document_id");--> statement-breakpoint
CREATE INDEX "run_documents_owner_run_idx" ON "run_documents" USING btree ("owner_id","run_id");
