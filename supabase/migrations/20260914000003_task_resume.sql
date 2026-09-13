-- =============================================================================
-- Resume support.
--
-- PAUSE is a control-plane action, not a domain transition: the orchestrator's
-- state machine has no PAUSED state because a paused task is simply not being
-- worked on. Without recording what the task was doing, RESUME would have to
-- guess a target state, which would silently corrupt the lifecycle.
--
-- `resume_status` remembers the status the task held when it was paused.
-- =============================================================================

alter table tasks
  add column if not exists resume_status text;

-- Constrain it to the same vocabulary as `status`, but allow null.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_resume_status_check'
  ) then
    alter table tasks
      add constraint tasks_resume_status_check
      check (resume_status is null or resume_status in (
        'PENDING','CODING','TESTING','REVIEW','REJECTED','FIXING',
        'APPROVED','DONE','NEEDS_HUMAN','PAUSED','CANCELLED'
      ));
  end if;
end $$;
