-- OPTIONAL, and intentionally a separate file from the migration that defines
-- prune_stale_rooms(): pg_cron has to be enabled on the project first, and if `create extension`
-- fails it aborts the whole batch it was pasted into. Keeping it apart means a project without
-- pg_cron still gets the cap and the reaper - it just doesn't get the background sweep.
--
-- This job is a tidiness pass, not the safety net. The room cap prunes on every create, so the
-- limit can never lock players out even if this never runs; all this adds is clearing dead rooms
-- during quiet periods when nobody is creating anything.
--
-- Enable pg_cron first: Dashboard > Database > Extensions > pg_cron.

create extension if not exists pg_cron;

-- cron.schedule() errors on a duplicate job name, so drop any previous copy to keep this re-runnable.
select cron.unschedule('prune-stale-rooms')
where exists (select 1 from cron.job where jobname = 'prune-stale-rooms');

select cron.schedule(
  'prune-stale-rooms',
  '*/15 * * * *',
  $$select public.prune_stale_rooms()$$
);
