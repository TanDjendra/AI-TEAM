-- Phase V2-10: Staging Integration Candidate
-- Tracks merge requests from AI execution branches to the main branch.

CREATE TABLE integration_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id text NOT NULL,
    node_id text NOT NULL,
    source_branch text NOT NULL,
    target_branch text NOT NULL,
    diff_summary text NOT NULL,
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'MERGED', 'FAILED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    error_details text
);

-- Index to quickly query pending integration candidates for human review or for a specific workflow
CREATE INDEX idx_integration_candidates_status ON integration_candidates(status);
CREATE INDEX idx_integration_candidates_workflow ON integration_candidates(workflow_id);
