-- What the public gets to see of the tournament system, and when.
--
-- Nothing tournament-shaped appears on a non-admin page until an administrator opens an event for
-- signup (a draft is invisible to non-admins - the "tournaments select" policy). This migration adds
-- the one thing that policy cannot express: the Official stat category is hidden until the FIRST
-- event has gone live, and stays visible after that.
--
-- -- "Has ever gone live", not "is live now" -----------------------------------------------------------
-- Official matches count toward careers and the leaderboard for good. If the stat's visibility
-- followed the status of the events, cancelling the one and only event that ever ran would hide the
-- category while the games it produced still counted - a leaderboard with numbers in it that no page
-- explains. So the moment an event first goes live is recorded (went_live_at) and never cleared: not
-- by a cancel, not by a finish, not by an admin reopening it.
--
-- -- Events are independent -----------------------------------------------------------------------------
-- More than one event can run at once. Nothing here is global: teams, rosters, free agents, entry codes,
-- brackets, deadlines, cancelling and finishing are all scoped to an event, and one person can be on a
-- team in each of several events (the one-team-per-person rule is per event). Entry codes are unique
-- within an event, NOT across them, so two events can hand out the same code; anything that takes a
-- code - the official-match lobby, later - has to be told which event first.

alter table public.tournaments add column if not exists went_live_at timestamptz;

comment on column public.tournaments.went_live_at is
  'When the event first became live. Set once and never cleared, so it survives a cancel, a finish, or an admin reopening the event. What the Official stat category''s visibility is keyed on.';

-- Stamped on insert too: an event can be created already live (by a migration or the SQL editor), and
-- "first went live" is then the moment it appeared.
create or replace function public.stamp_tournament_went_live()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'live' and new.went_live_at is null then
    new.went_live_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists tournaments_stamp_went_live on public.tournaments;
create trigger tournaments_stamp_went_live
  before insert or update on public.tournaments
  for each row execute function public.stamp_tournament_went_live();

-- Events that were already live when this ran (there are none yet, but a re-run must not lose one).
update public.tournaments set went_live_at = now() where status in ('live', 'finished') and went_live_at is null;

-- -- The name people are invited by ---------------------------------------------------------------------
-- An event's name is chosen by an administrator and printed to the public: "Sign up for <name> now!".
-- It is stored tidy - trimmed, and any run of whitespace (including a pasted line break) collapsed to a
-- single space - so the headline and every other place it appears agree, whatever was typed. The
-- length rule stays on the column (3-80 characters after trimming); this only normalizes what is kept.
create or replace function public.normalize_tournament_name()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.name := btrim(regexp_replace(new.name, '\s+', ' ', 'g'));
  return new;
end;
$$;

drop trigger if exists tournaments_normalize_name on public.tournaments;
create trigger tournaments_normalize_name
  before insert or update of name on public.tournaments
  for each row execute function public.normalize_tournament_name();

-- Tidy any name that is already stored.
update public.tournaments set name = btrim(regexp_replace(name, '\s+', ' ', 'g'))
 where name is distinct from btrim(regexp_replace(name, '\s+', ' ', 'g'));

-- The public may ask "should the Official stat exist?" without being able to read the events
-- themselves. Definer, so it answers the same for everybody and never leaks anything about which
-- events exist or what state they are in - just a yes or a no.
create or replace function public.official_stats_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from tournaments t where t.went_live_at is not null);
$$;

grant execute on function public.official_stats_enabled() to anon, authenticated;
