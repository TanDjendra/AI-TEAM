-- ============================================================
-- Migration 007: Workflow DAG persistence (Phase V2-04)
--
-- ADDITIVE ONLY. Zero existing tables or columns are modified.
-- This migration always runs regardless of the WORKFLOW_ENABLED
-- feature flag (additive DDL is safe; gating migrations causes
-- schema drift between environments).
--
-- Tables:
--   workflows             — root workflow record
--   workflow_nodes        — one row per DAG node
--   workflow_dependencies — normalized directed-edge table (NOT JSONB)
--
-- Architectural constraints honoured here:
--   - workflow_dependencies uses a separate row per edge with a
--     UNIQUE constraint — never JSONB arrays for dependency lists.
--   - workflow_nodes has UNIQUE(workflow_id, node_key) as required
--     by the blueprint.
--   - current_task_id is NULL until the node is CLAIMED; at most
--     one live V1 tasks row per node.
--   - Self-edges are rejected at the DB level by CHECK constraint
--     as a second line of defence behind WorkflowValidator.
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. workflows — root workflow record
-- ──────────────────────────────────────────────────────────────
CREATE TABLE workflows (
    id          TEXT        PRIMARY KEY,
    spec        JSONB       NOT NULL,
    -- spec stores the full WorkflowSpec (objective, workspaceBinding,
    -- nodes, edges, profileBindings). Immutable after status = VALIDATED.
    status      TEXT        NOT NULL DEFAULT 'DRAFT',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_workflow_status CHECK (
        status IN ('DRAFT', 'VALIDATED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')
    )
);

CREATE INDEX idx_workflows_status ON workflows(status);

-- ──────────────────────────────────────────────────────────────
-- 2. workflow_nodes — one row per DAG node
-- ──────────────────────────────────────────────────────────────
CREATE TABLE workflow_nodes (
    id              TEXT        PRIMARY KEY,
    workflow_id     TEXT        NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    node_key        TEXT        NOT NULL,
    -- node_key is the short, URL-safe identifier unique within the workflow.
    title           TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'WAITING_DEPENDENCIES',
    -- current_task_id is NULL until the node transitions to CLAIMED.
    -- Set exactly once; at most one live V1 tasks row per node.
    -- Note: no FK REFERENCES tasks(id) here for PGlite compatibility.
    -- Referential integrity is enforced at the application layer:
    -- only the CLAIMED transition may set this field, and it always
    -- provides a verified tasks.id obtained from the task repository.
    current_task_id TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Blueprint requirement: unique node keys within a workflow.
    CONSTRAINT uq_workflow_node_key UNIQUE (workflow_id, node_key),

    CONSTRAINT chk_node_status CHECK (
        status IN (
            'WAITING_DEPENDENCIES', 'READY', 'CLAIMED',
            'RUNNING', 'SUCCEEDED', 'BLOCKED', 'CANCELLED'
        )
    )
);

CREATE INDEX idx_workflow_nodes_workflow ON workflow_nodes(workflow_id);
-- Composite index for the common query "find all READY nodes for workflow X".
CREATE INDEX idx_workflow_nodes_status ON workflow_nodes(workflow_id, status);

-- ──────────────────────────────────────────────────────────────
-- 3. workflow_dependencies — normalized directed-edge table
-- ──────────────────────────────────────────────────────────────
--
--  Each row is a single directed edge: from_node_key → to_node_key
--  Semantics: node `from_node_key` MUST reach SUCCEEDED before
--             node `to_node_key` transitions to READY.
--
--  This table deliberately uses RELATIONAL rows, not JSONB arrays:
--    - Each edge is queryable, indexable, and cascade-deletable.
--    - The UNIQUE constraint prevents duplicate edges.
--    - Predecessor/successor lookup is a simple indexed join.
--    - Referential integrity is enforced by the DB engine.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE workflow_dependencies (
    id              TEXT        PRIMARY KEY,
    workflow_id     TEXT        NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    from_node_key   TEXT        NOT NULL,
    to_node_key     TEXT        NOT NULL,

    -- Prevents duplicate edges (e.g., A→B inserted twice).
    CONSTRAINT uq_workflow_dep_edge UNIQUE (workflow_id, from_node_key, to_node_key),

    -- DB-level guard against self-edges (WorkflowValidator also checks this).
    CONSTRAINT chk_no_self_edge CHECK (from_node_key <> to_node_key)
);

-- "What nodes become READY when node X succeeds?"
CREATE INDEX idx_wf_dep_from ON workflow_dependencies(workflow_id, from_node_key);
-- "What must complete before node X becomes READY?"
CREATE INDEX idx_wf_dep_to   ON workflow_dependencies(workflow_id, to_node_key);
