-- Phase V2-07: Workspace Allocations
-- Tracks directory and git worktree assignments to ensure isolation.

CREATE TABLE workspace_allocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Optional link to tasks (task_id). No FK constraint for PGlite compatibility.
    task_id text,
    mode text NOT NULL CHECK (mode IN ('DIRECTORY', 'GIT_WORKTREE')),
    workspace_root text NOT NULL,
    base_ref text NOT NULL,
    branch_name text, -- Required if mode = 'GIT_WORKTREE'
    ownership_token text NOT NULL,
    status text NOT NULL DEFAULT 'ALLOCATED' CHECK (status IN ('ALLOCATED', 'CLEANED', 'FAILED_CLEANUP')),
    created_at timestamptz NOT NULL DEFAULT now(),
    cleaned_at timestamptz,
    CONSTRAINT workspace_allocations_branch_check CHECK (
        (mode = 'GIT_WORKTREE' AND branch_name IS NOT NULL) OR
        (mode = 'DIRECTORY' AND branch_name IS NULL)
    )
);

-- Index for cleanup jobs or status lookups
CREATE INDEX idx_workspace_allocations_status ON workspace_allocations(status);
