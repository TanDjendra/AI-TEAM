-- =============================================================================
-- Event ordering.
--
-- `created_at` has millisecond resolution and the orchestrator publishes many
-- events within the same millisecond, so timestamp alone cannot order the
-- journal — a replaying dashboard would see an arbitrary order and could
-- reconstruct the wrong state sequence.
--
-- `publish_seq` is a monotonic per-database counter allocated at insert time by
-- a sequence. Ordering by it is total, stable and cheap.
-- =============================================================================

create sequence if not exists activity_logs_publish_seq;

alter table activity_logs
  add column if not exists publish_seq bigint;

-- Backfill any pre-existing rows in their current (timestamp) order so the
-- column is never left null for old data.
update activity_logs
   set publish_seq = nextval('activity_logs_publish_seq')
 where publish_seq is null;

alter table activity_logs
  alter column publish_seq set default nextval('activity_logs_publish_seq');

alter table activity_logs
  alter column publish_seq set not null;

-- The ordering index a dashboard replay uses.
create index if not exists activity_logs_publish_seq_idx
  on activity_logs (task_id, publish_seq);
