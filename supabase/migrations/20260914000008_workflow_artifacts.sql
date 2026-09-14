-- Phase V2-06: Artifact manifests
-- Bounded handoff mechanism relying on local paths and checksums,
-- no S3/blob storage.

CREATE TABLE IF NOT EXISTS workflow_artifacts (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    producer_node_key TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    checksum TEXT NOT NULL,
    size_bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT workflow_artifacts_unique_name UNIQUE (workflow_id, producer_node_key, name)
);

CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_workflow_id ON workflow_artifacts(workflow_id);
