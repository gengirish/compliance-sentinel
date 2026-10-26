-- A human-readable reason for runs that end without an audit, e.g. a skip.
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS note text;
-- Runs are only ever skipped for this reason, so earlier skips can be backfilled.
UPDATE audit_runs SET note = 'No new or amended rules since the last check, so there was nothing to audit.'
  WHERE status = 'skipped' AND note IS NULL;
