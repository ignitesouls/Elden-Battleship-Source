-- 1. Custom team names, and 2. a real lock on switching teams mid-match.

-- -- Custom team names ------------------------------------------------------
-- Teams have been identified purely by palette slot ("Red Fleet", "Blue Fleet"), which is fine
-- for pickup games and flat for anything with actual crews in it.
--
-- A sparse array of overrides, indexed by team number: null or a blank entry means "keep the
-- color name". Stored per room rather than globally so a name belongs to the match it was used
-- in, and so the default palette names survive untouched for every other room.
alter table rooms add column if not exists team_names jsonb;

-- -- Teams lock once a match starts -----------------------------------------
-- Switching teams between games is legitimate; switching mid-match is not - it would strand the
-- fleet you placed, hand you a second team's board, and make the attack log's attacker_team
-- retroactively wrong.
--
-- Until now this was enforced only by the lobby being the sole screen offering a team picker,
-- which is no enforcement at all: "players update own" permits any column at any time, so a
-- direct PATCH could do it. A trigger is the right tool rather than tightening that policy,
-- because the restriction applies to ONE column - host migration (is_host), renames (nickname)
-- and rejoin-code redemption (user_id) all have to keep working mid-match.
create or replace function public.guard_team_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.team is distinct from old.team
     and exists (
       select 1 from rooms r
        where r.id = new.room_id
          and r.status in ('placement', 'battle')
     )
  then
    raise exception 'Teams are locked once a match has started - wait for it to finish';
  end if;

  return new;
end;
$$;

-- 'lobby' and 'finished' both stay open, which is what "between games" means in practice: the
-- post-match screen and the lobby you return to afterwards.
drop trigger if exists players_guard_team_changes on players;
create trigger players_guard_team_changes
  before update on players
  for each row execute function public.guard_team_changes();
