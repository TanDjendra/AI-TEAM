ALTER TABLE model_usage_ledger ADD COLUMN IF NOT EXISTS estimated_cost_usd DOUBLE PRECISION;
ALTER TABLE model_usage_ledger ADD COLUMN IF NOT EXISTS price_version TEXT;
ALTER TABLE model_usage_ledger ADD COLUMN IF NOT EXISTS profile_snapshot_hash TEXT;
