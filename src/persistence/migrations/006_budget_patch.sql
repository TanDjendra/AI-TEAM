ALTER TABLE model_usage_ledger
ADD COLUMN estimated_cost_usd NUMERIC,
ADD COLUMN price_version TEXT NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN profile_snapshot_hash TEXT NOT NULL DEFAULT 'UNKNOWN';
