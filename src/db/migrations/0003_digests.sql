-- Keep the previous text of an amended rule, so a digest can say what changed.
ALTER TABLE rules ADD COLUMN IF NOT EXISTS previous_raw_text text;

-- Structured, human-readable summaries of new or amended rules: one per rule version.
CREATE TABLE IF NOT EXISTS rule_digests (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  rule_id bigint NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('new', 'amended')),
  digest jsonb NOT NULL,
  analyst text NOT NULL,
  cost_usd double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, content_hash)
);
CREATE INDEX IF NOT EXISTS rule_digests_rule_id_idx ON rule_digests (rule_id);
