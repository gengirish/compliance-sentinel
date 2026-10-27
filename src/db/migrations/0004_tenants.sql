-- Tenants: one per GitHub App installation, optionally linked to a Clerk organization.
-- Rule text (rules, rule_chunks, rule_digests, embedding_cache) is public and stays shared.
CREATE TABLE IF NOT EXISTS tenants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  github_installation_id bigint UNIQUE,
  clerk_org_id text UNIQUE,
  -- Fixture prefixes this tenant is audited against; empty means no restriction.
  rule_packs text[] NOT NULL DEFAULT '{pci}',
  monthly_budget_usd double precision NOT NULL DEFAULT 25,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The operator's own tenant. The table is new, so it gets id 1 (LOCAL_TENANT_ID): CLI runs,
-- evals, the GitHub Action and requests without a tenant header all belong to it.
INSERT INTO tenants (name, rule_packs, monthly_budget_usd) VALUES ('local', '{}', 1000000);

CREATE TABLE IF NOT EXISTS repos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  github_repo_id bigint UNIQUE,
  full_name text NOT NULL,
  default_branch text,
  -- The last completed audit of the default branch; PR runs are compared with it.
  baseline_run_id bigint,
  baseline_sha text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, full_name)
);

-- Every repository indexed so far was the operator's.
INSERT INTO repos (tenant_id, full_name) SELECT DISTINCT 1, repo FROM code_chunks;

ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS repo_id bigint REFERENCES repos (id) ON DELETE CASCADE;
UPDATE code_chunks SET repo_id = repos.id FROM repos WHERE repos.tenant_id = 1 AND repos.full_name = code_chunks.repo;
ALTER TABLE code_chunks ALTER COLUMN repo_id SET NOT NULL;
DROP INDEX IF EXISTS code_chunks_repo_path_idx;
ALTER TABLE code_chunks DROP COLUMN IF EXISTS repo;
CREATE INDEX IF NOT EXISTS code_chunks_repo_commit_path_idx ON code_chunks (repo_id, commit_sha, path);

-- Runs belong to a tenant. The default only backfills existing rows; new inserts must say whose run it is.
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS tenant_id bigint NOT NULL DEFAULT 1 REFERENCES tenants (id) ON DELETE CASCADE;
ALTER TABLE audit_runs ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS repo_id bigint REFERENCES repos (id) ON DELETE SET NULL;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS head_sha text;
CREATE INDEX IF NOT EXISTS audit_runs_tenant_id_idx ON audit_runs (tenant_id, id DESC);
