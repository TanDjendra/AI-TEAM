-- =============================================================================
-- PHASE 6: human control.
--
-- Two additions, both about making human actions and worker ownership explicit
-- in the database rather than inferred:
--
--   1. task_interrupts — a durable "a human asked to pause/cancel" record.
--      Cooperative pause cannot rely on an in-memory flag: the worker handling
--      the task may be in another process, and the request must survive a
--      restart. The worker polls this table at its safe points.
--
--   2. tasks.heartbeat_at — the liveness signal. A row still RUNNING whose
--      heartbeat has stopped means the owning process died. Without this,
--      "stale" could only be guessed from started_at, which is wrong for a
--      long-running but healthy task.
-- =============================================================================

create table if not exists task_interrupts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  intent text not null check (intent in ('pause', 'cancel')),
  reason text not null,
  actor text not null default 'human',
  requested_at timestamptz not null default now(),
  -- Set by the worker once it has observed and acted on the request.
  acknowledged_at timestamptz,
  acknowledged_by text
);

-- At most one outstanding request per (task, intent): a double-click on Pause
-- records one interrupt, not two.
create unique index if not exists task_interrupts_outstanding_key
  on task_interrupts (task_id, intent)
  where acknowledged_at is null;

create index if not exists task_interrupts_task_idx
  on task_interrupts (task_id, requested_at desc);

-- Liveness. Nullable so existing rows and non-worker states need no backfill.
alter table tasks add column if not exists heartbeat_at timestamptz;

-- Stale-run sweeps filter on this: RUNNING rows whose heartbeat stopped.
create index if not exists tasks_heartbeat_idx
  on tasks (heartbeat_at)
  where heartbeat_at is not null;
