-- Phase 7B: Reliability and Recovery

-- Adds current_phase to tasks to track execution phase checkpoints
ALTER TABLE tasks ADD COLUMN current_phase text;
ALTER TABLE tasks ADD COLUMN recovery_metadata jsonb;

-- Adds recovery_metadata to runs to track the exact state when a run crashes
ALTER TABLE task_runs ADD COLUMN recovery_metadata jsonb;
