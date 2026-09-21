-- Cancelling a tournament that has already started.
--
-- `cancelled` was always a legal status, and an admin could always set it - but as a bare label it
-- did nothing. A "cancelled" event would still have taken results: an official game finishing
-- inside it would have advanced a bracket nobody was running any more. So cancelling is two things,
-- and this migration is both: a proper action (with a reason, and a time, for the public page to
-- show), and a freeze, so that once an event is cancelled nothing can be written into its bracket.
--
-- -- What cancelling does and doesn't do ------------------------------------------------------------
--   * Works from any state but finished: draft, signup, or live with a half-played bracket. An event
--     that has finished can't be cancelled - it happened - and one already cancelled can't be twice.
--   * Freezes the bracket. Every write to tournament_matches is refused, which covers an admin
--     entering a score, and - the case that matters - archive_match feeding in an official game that
--     was still running when the cancel happened. It is a trigger on the table, not a check in one
--     function, so there is no second door to forget.
--   * Closes signup, and with it every pending invitation: the roster guard already refuses a join
--     once signup isn't open, so an invitee accepting into a cancelled event is turned away.
--   * Deletes nothing. The bracket, the results, the rosters and the entry codes all stay, and the
--     event stays visible with its reason. What was played was played.
--   * Is reversible. An admin can move the event back to live (or signup) and the freeze lifts. That
--     is deliberate: a cancel is a decision about the future of an event, made in a hurry, by a person,
--     and a mis-click on a running tournament shouldn't be unrecoverable.

alter table public.tournaments add column if not exists cancelled_at timestamptz;
alter table public.tournaments add column if not exists cancel_reason text;

comment on column public.tournaments.cancelled_at is
  'When an administrator cancelled the event. Stamped by tournaments_stamp_cancel; cleared if the event is reopened.';
comment on column public.tournaments.cancel_reason is
  'Why it was cancelled, shown on the event page. Optional.';

-- -- Stamp the moment, however the status got changed ---------------------------------------------
-- A trigger rather than something cancel_tournament() does, so that setting the status from the SQL
-- editor or any other route leaves the same record as the button does.
create or replace function public.stamp_tournament_cancel()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    new.cancelled_at := now();
  elsif old.status = 'cancelled' and new.status <> 'cancelled' then
    new.cancelled_at := null;
    new.cancel_reason := null;
  end if;
  return new;
end;
$$;

drop trigger if exists tournaments_stamp_cancel on public.tournaments;
create trigger tournaments_stamp_cancel
  before update on public.tournaments
  for each row execute function public.stamp_tournament_cancel();

-- -- The freeze -----------------------------------------------------------------------------------
-- Definer so it can read the tournament's status whoever is writing. Everything that changes a
-- bracket funnels through UPDATE or INSERT on this table - the admin's score function, the
-- placement of a winner into the next round, and the direct writes an admin makes when drawing a
-- stage - so guarding the table guards all of them at once.
--
-- The SQL editor and the service key stay exempt, for the same reason as the other guards: somebody
-- has to be able to repair a bracket by hand.
create or replace function public.guard_matches_when_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_service_session() then
    return new;
  end if;
  if exists (select 1 from tournaments t where t.id = new.tournament_id and t.status = 'cancelled') then
    raise exception 'This event has been cancelled - its bracket is frozen';
  end if;
  return new;
end;
$$;

drop trigger if exists tournament_matches_frozen_when_cancelled on public.tournament_matches;
create trigger tournament_matches_frozen_when_cancelled
  before insert or update on public.tournament_matches
  for each row execute function public.guard_matches_when_cancelled();

-- -- The action -----------------------------------------------------------------------------------
create or replace function public.cancel_tournament(p_tournament uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can cancel an event';
  end if;

  select t.status into current_status from tournaments t where t.id = p_tournament for update;
  if current_status is null then
    raise exception 'There is no such event';
  end if;
  if current_status = 'cancelled' then
    raise exception 'That event is already cancelled';
  end if;
  if current_status = 'finished' then
    raise exception 'That event has finished - it can no longer be cancelled';
  end if;

  update tournaments
     set status = 'cancelled',
         cancel_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_tournament;
end;
$$;

grant execute on function public.cancel_tournament(uuid, text) to authenticated;
