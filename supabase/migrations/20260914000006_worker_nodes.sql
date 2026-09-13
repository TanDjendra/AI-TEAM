-- PHASE 7D: Worker Nodes
-- Tracks long-running background worker processes. Used by the dashboard to show real uptime and health.

create table worker_nodes (
  id uuid primary key default gen_random_uuid(),
  process_id integer not null,
  status text not null,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now()
);

create index worker_nodes_status_idx on worker_nodes (status);
