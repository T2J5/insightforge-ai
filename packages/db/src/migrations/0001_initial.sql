CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE research_focus AS ENUM ('comprehensive', 'product', 'technology', 'business', 'competition');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE research_depth AS ENUM ('quick', 'deep');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE run_status AS ENUM ('queued', 'running', 'awaiting_review', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE document_status AS ENUM ('uploaded', 'processing', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE evidence_source_type AS ENUM ('web', 'document');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE report_version_status AS ENUM ('draft', 'published');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  company text NOT NULL,
  focus research_focus NOT NULL,
  depth research_depth NOT NULL,
  status run_status NOT NULL DEFAULT 'queued',
  token_usage integer NOT NULL DEFAULT 0 CHECK (token_usage >= 0),
  estimated_cost_cny numeric(12, 4) NOT NULL DEFAULT 0 CHECK (estimated_cost_cny >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_runs_owner_id_idx ON research_runs (owner_id);

CREATE TABLE IF NOT EXISTS run_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  checkpoint_key text NOT NULL,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS run_checkpoints_run_key_uidx ON run_checkpoints (run_id, checkpoint_key);
CREATE INDEX IF NOT EXISTS run_checkpoints_run_id_idx ON run_checkpoints (run_id);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  storage_key text NOT NULL,
  content_hash text NOT NULL,
  status document_status NOT NULL DEFAULT 'uploaded',
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_owner_id_idx ON documents (owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS documents_owner_hash_uidx ON documents (owner_id, content_hash);

CREATE TABLE IF NOT EXISTS document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  content text NOT NULL,
  heading text,
  page integer CHECK (page IS NULL OR page > 0),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_chunks_owner_id_idx ON document_chunks (owner_id);
CREATE INDEX IF NOT EXISTS document_chunks_document_id_idx ON document_chunks (document_id);
CREATE INDEX IF NOT EXISTS document_chunks_embedding_hnsw_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS evidence (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  claim text NOT NULL,
  source_type evidence_source_type NOT NULL,
  source_url text,
  source_title text,
  publisher text,
  published_at timestamptz,
  retrieved_at timestamptz NOT NULL,
  quote text NOT NULL,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  page integer CHECK (page IS NULL OR page > 0),
  confidence numeric(5, 4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  content_hash text NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_owner_id_idx ON evidence (owner_id);
CREATE INDEX IF NOT EXISTS evidence_run_id_idx ON evidence (run_id);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_run_hash_uidx ON evidence (run_id, content_hash);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_owner_id_idx ON reports (owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS reports_run_id_uidx ON reports (run_id);

CREATE TABLE IF NOT EXISTS report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  content jsonb NOT NULL,
  status report_version_status NOT NULL,
  quality_warning text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS report_versions_report_version_uidx ON report_versions (report_id, version);
CREATE INDEX IF NOT EXISTS report_versions_report_id_idx ON report_versions (report_id);

CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  operation text NOT NULL,
  model text,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_cny numeric(12, 4) NOT NULL DEFAULT 0 CHECK (cost_cny >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_owner_id_idx ON usage_events (owner_id);
