-- Which regulatory sources are scraped, switched from the dashboard. A source with no row
-- falls back to its SCRAPE_* environment flag, so existing deployments keep their behaviour.
CREATE TABLE IF NOT EXISTS source_settings (
  name text PRIMARY KEY,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
