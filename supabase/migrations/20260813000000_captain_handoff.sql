-- Handing command of a fleet to a crewmate, in the lobby.
--
-- Captaincy is derived, not stored: team_captain() picks the earliest team_joined_at on the fleet
-- (see the fleet_captains migration for why a flag would be worse). So a handover is not a new
-- piece of state - it is moving the target's team_joined_at ahead of everyone else's, after which
-- every client recomputes the same answer with nothing else to write and no old captain to demote.
--
-- This has to be a function rather than a client-side update, because it writes SOMEBODY ELSE'S
-- player row and "players update own" allows a client to touch only its own.

/**
 * Makes p_target the captain of their fleet. Only the fleet's current captain may call it.
 *
 * Raises rather than returning false on refusal. A silent no-op is the failure mode this project
 * has been bitten by before - RLS makes a blocked UPDATE report success and affect zero rows - and
 * a handover that appears to work while the board stays under someone else's control is exactly
 * that bug wearing a button.
 */
create or replace function public.hand_over_captaincy(p_target uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room  uuid;
  v_team  int;
  v_first timestamptz;
begin
  select room_id, team into v_room, v_team
    from players
   where id = p_target;

  if v_room is null then
    raise exception 'No such player';
  end if;
  if v_team is null then
    raise exception 'That player is spectating, not on your fleet';
  end if;

  -- Lobby only. Mid-match the fleet is already placed or being placed under the current captain's
  -- hands, and moving the controls then would strand a half-laid board.
  if not exists (select 1 from rooms r where r.id = v_room and r.status = 'lobby') then
    raise exception 'Command can only change hands in the lobby';
  end if;

  if not public.is_admin()
     and not exists (
       select 1 from players p
        where p.id = public.team_captain(v_room, v_team)
          and p.user_id = auth.uid()
     )
  then
    raise exception 'Only the fleet captain can hand over command';
  end if;

  select min(team_joined_at) into v_first
    from players
   where room_id = v_room and team = v_team;

  -- Strictly earlier than the current earliest, so team_captain()'s id tie-break never comes into
  -- it. coalesce covers a fleet whose members all predate the team_joined_at column: those rows
  -- sort last, so any real timestamp beats them.
  update players
     set team_joined_at = coalesce(v_first, now()) - interval '1 millisecond'
   where id = p_target;

  return true;
end;
$$;

grant execute on function public.hand_over_captaincy(uuid) to anon, authenticated;

-- -- Nobody takes command by hand mid-match ----------------------------------
-- guard_team_changes has locked the `team` column during a match since the team_names_and_lock
-- migration, but team_joined_at was left open - and now that it decides who places the ships, a
-- direct PATCH of your own row during 'placement' is a way to seize the board out from under the
-- captain mid-layout. The legitimate writer of that column is setPlayerTeam, which always changes
-- `team` at the same time and is therefore already blocked in these phases.
--
-- Redefined in full because create-or-replace cannot patch a function body.
create or replace function public.guard_team_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.team is distinct from old.team
      or new.team_joined_at is distinct from old.team_joined_at)
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

-- The trigger already points at this function; recreated anyway so this file stands on its own.
drop trigger if exists players_guard_team_changes on players;
create trigger players_guard_team_changes
  before update on players
  for each row execute function public.guard_team_changes();
