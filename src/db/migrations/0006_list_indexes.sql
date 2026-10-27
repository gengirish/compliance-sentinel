-- Indexes for the dashboard's sorted and filtered lists (docs/plan-filter-sort.md).
CREATE INDEX IF NOT EXISTS audit_runs_tenant_started_idx ON audit_runs (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS rules_last_changed_idx ON rules (last_changed_at DESC);
