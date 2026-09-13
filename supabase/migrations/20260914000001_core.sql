-- =============================================================================
-- AI Team Orchestrator — core schema
--
-- Runs unchanged on PostgreSQL (Supabase) and on PGlite (tests).
-- Every statement is idempotent so migrations are safe to re-apply.
-- =============================================================================

-- NOTE: `pgcrypto` is deliberately NOT required.
-- `gen_random_uuid()` has been in PostgreSQL core since v13, and requiring the
-- extension breaks environments where it is not installed (PGlite, managed
-- Postgres with a restricted extension allow-list) for no benefit.

-- --- updated_at maintenance ---------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- --- agents -------------------------------------------------------------------
create table if not exists agents (
  id              uuid primary key default gen_random_uuid(),
  -- Stable logical identity, e.g. "coder-agent". Unique so re-registering the
  -- same agent is an upsert rather than a duplicate row.
  agent_key       text not null unique,
  role            text not null check (role in ('coder', 'reviewer', 'orchestrator')),
  provider        text not null,
  model           text not null,
  status          text not null default 'IDLE'
                  check (status in ('IDLE', 'WORKING', 'REVIEWING', 'ERROR', 'OFFLINE')),
  current_task_id uuid,
  last_seen       timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists agents_set_updated_at on agents;
create trigger agents_set_updated_at before update on agents
  for each row execute function set_updated_at();

-- --- tasks --------------------------------------------------------------------
create table if not exists tasks (
  id                uuid primary key default gen_random_uuid(),
  -- Human/project identifier, e.g. "TASK-001".
  external_id       text not null unique,
  title             text not null,
  description       text not null,
  status            text not null default 'PENDING'
                    check (status in ('PENDING','CODING','TESTING','REVIEW','REJECTED',
                                      'FIXING','APPROVED','DONE','NEEDS_HUMAN',
                                      'PAUSED','CANCELLED')),
  assigned_agent_id uuid references agents(id) on delete set null,
  workspace         text not null,
  current_cycle     integer not null default 0 check (current_cycle >= 0),
  max_review_cycles integer not null default 3 check (max_review_cycles >= 1),
  stop_reason       text,
  approved          boolean not null default false,
  -- Monotonic guard: a state update is only accepted when it advances this
  -- column, which is what makes duplicate/out-of-order transitions a no-op.
  transition_seq    integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  started_at        timestamptz,
  completed_at      timestamptz
);

drop trigger if exists tasks_set_updated_at on tasks;
create trigger tasks_set_updated_at before update on tasks
  for each row execute function set_updated_at();

create index if not exists tasks_status_idx on tasks (status);
create index if not exists tasks_created_at_idx on tasks (created_at desc);

-- --- task_runs -----------------------------------------------------------------
create table if not exists task_runs (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references tasks(id) on delete cascade,
  -- Stable id for the unit of work that produced the records.
  run_id         text not null,
  status         text not null default 'RUNNING'
                 check (status in ('RUNNING','COMPLETED','FAILED','INTERRUPTED','CANCELLED')),
  agent_id       uuid references agents(id) on delete set null,
  cycle          integer not null default 0 check (cycle >= 0),
  reason         text,
  stop_reason    text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  duration_ms    integer,
  total_tokens   integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists task_runs_set_updated_at on task_runs;
create trigger task_runs_set_updated_at before update on task_runs
  for each row execute function set_updated_at();

create index if not exists task_runs_task_idx on task_runs (task_id, started_at desc);
-- A run id identifies exactly one run.
create unique index if not exists task_runs_run_id_key on task_runs (run_id);

-- --- reviews -------------------------------------------------------------------
-- One row per review pass. Never updated after insert: history is append-only.
create table if not exists reviews (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references tasks(id) on delete cascade,
  run_id         uuid references task_runs(id) on delete set null,
  reviewer       text not null,
  cycle          integer not null check (cycle >= 1),
  verdict        text not null check (verdict in ('APPROVED','REJECTED')),
  severity       text not null check (severity in ('NONE','LOW','MEDIUM','HIGH','CRITICAL')),
  summary        text not null,
  issues         jsonb not null default '[]'::jsonb,
  required_fixes jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  -- One verdict per (task, cycle): enforcing this in the schema is the database
  -- half of "two reviewers must not both decide cycle 2".
  unique (task_id, cycle)
);

create index if not exists reviews_task_idx on reviews (task_id, cycle);

-- --- activity_logs -------------------------------------------------------------
-- The append-only event journal AND the idempotency ledger: `event_id` is the
-- primary key, so a redelivered event cannot be written twice.
create table if not exists activity_logs (
  event_id    text primary key,
  task_id     uuid references tasks(id) on delete cascade,
  run_id      uuid references task_runs(id) on delete set null,
  agent_id    uuid references agents(id) on delete set null,
  event_type  text not null,
  cycle       integer check (cycle is null or cycle >= 0),
  payload     jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  created_at  timestamptz not null default now()
);

-- Ordering must be total and deterministic: two events in the same millisecond
-- still need a stable order for a replaying dashboard.
create index if not exists activity_logs_stream_idx
  on activity_logs (task_id, occurred_at, created_at, event_id);
create index if not exists activity_logs_type_idx on activity_logs (event_type, occurred_at desc);

-- --- tool_calls -----------------------------------------------------------------
create table if not exists tool_calls (
  id             uuid primary key default gen_random_uuid(),
  tool_call_id   text not null,
  task_id        uuid not null references tasks(id) on delete cascade,
  agent_id       uuid references agents(id) on delete set null,
  tool           text not null,
  arguments      jsonb not null default '{}'::jsonb,
  started_at     timestamptz not null,
  finished_at    timestamptz,
  duration_ms    integer,
  success        boolean,
  exit_code      integer,
  output_summary text,
  created_at     timestamptz not null default now(),
  -- Idempotency: the same tool call cannot be recorded twice.
  unique (task_id, tool_call_id)
);

create index if not exists tool_calls_task_idx on tool_calls (task_id, started_at);

-- --- file_changes ---------------------------------------------------------------
create table if not exists file_changes (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references tasks(id) on delete cascade,
  agent_id      uuid references agents(id) on delete set null,
  path          text not null,
  change_type   text not null check (change_type in ('created','modified','deleted')),
  summary       text,
  git_base_hash text,
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- One row per file per run: a second write to the same file updates the summary
-- instead of creating noise.
create unique index if not exists file_changes_unique_idx on file_changes (task_id, path);

-- --- test_results ----------------------------------------------------------------
create table if not exists test_results (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references tasks(id) on delete cascade,
  agent_id       uuid references agents(id) on delete set null,
  cycle          integer not null default 0 check (cycle >= 0),
  test_key       text not null,
  command        text not null,
  exit_code      integer,
  passed         boolean not null default false,
  timed_out      boolean not null default false,
  output_summary text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  duration_ms    integer,
  created_at     timestamptz not null default now()
);

create index if not exists test_results_task_idx on test_results (task_id, started_at);
-- At most one authoritative test result per task: "the last run is the truth".
create unique index if not exists test_results_authoritative_key
  on test_results (task_id) where (test_key = 'final');
