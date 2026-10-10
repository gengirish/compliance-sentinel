CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sources (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  kind text NOT NULL,
  url text NOT NULL,
  last_checked_at timestamptz
);

CREATE TABLE IF NOT EXISTS rules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES sources (id),
  external_id text NOT NULL,
  title text NOT NULL,
  effective_date text,
  url text NOT NULL,
  content_hash text NOT NULL,
  raw_text text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rules_source_external_idx ON rules (source_id, external_id);

CREATE TABLE IF NOT EXISTS rule_chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id bigint NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  section_ref text,
  text text NOT NULL,
  embedding vector(1024) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS rule_chunks_rule_id_idx ON rule_chunks (rule_id);
CREATE INDEX IF NOT EXISTS rule_chunks_embedding_idx ON rule_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS code_chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo text NOT NULL,
  commit_sha text NOT NULL,
  path text NOT NULL,
  start_line integer NOT NULL,
  end_line integer NOT NULL,
  text text NOT NULL,
  embedding vector(1024) NOT NULL
);
CREATE INDEX IF NOT EXISTS code_chunks_repo_path_idx ON code_chunks (repo, path);
CREATE INDEX IF NOT EXISTS code_chunks_embedding_idx ON code_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS audit_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL,
  trigger text NOT NULL,
  rules_in_scope integer[] NOT NULL DEFAULT '{}',
  report_url text,
  cost_usd double precision NOT NULL DEFAULT 0,
  error text
);

CREATE TABLE IF NOT EXISTS findings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES audit_runs (id) ON DELETE CASCADE,
  rule_id bigint NOT NULL REFERENCES rules (id),
  obligation text NOT NULL,
  status text NOT NULL,
  severity text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  citation_chunk_ids integer[] NOT NULL DEFAULT '{}',
  rationale text NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_run_id_idx ON findings (run_id);
CREATE INDEX IF NOT EXISTS findings_rule_id_idx ON findings (rule_id);

CREATE TABLE IF NOT EXISTS embedding_cache (
  hash text PRIMARY KEY,
  model text NOT NULL,
  embedding vector(1024) NOT NULL
);
