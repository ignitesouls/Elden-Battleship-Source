-- A fleet with no ships on it must never be able to enter a battle.
--
-- -- What happened in DEEPVOYAGE ------------------------------------------------------------------
--
-- Six players, two crews, an hour and eleven minutes of play, and one of the two fleets was never on
-- the board at all. Its row read:
--
--   team 2:  placements = NULL   placement_confirmed = false
--            ship_grid  = 196 cells   ship_hits_remaining = 13 counters
--   team 6:  placements = 7 ships  placement_confirmed = true
--            ship_grid  = 100 cells   ship_hits_remaining = 7 counters
--
-- on a 10x10 board with a 7-hull fleet. 196 cells and 13 hulls is fleetFor(14, "Armada"): the room
-- was 14x14 when that crew picked their colour, ensureFleet() stamped the row with the shape of the
-- room AT THAT MOMENT, the host resized the board to 10x10 afterwards, and nothing ever rewrote the
-- row - submitPlacement() never ran for that team, and the self-heal in useRoom that repairs a
-- misshapen fleet only runs while the room is in 'lobby'.
--
-- The match then started anyway, because the thing that decides whether a match may start is
-- `team_ready.ready` - a different table, holding a flag, which survives every settings change and
-- every abandoned round. resolve_attack() reads `placements -> ship_idx`, finds nothing, and returns
-- 'miss'. Forty-four shots at that fleet, forty-four misses, no hits, no possible elimination: the
-- crew with no ships could not lose, and their opponents could not win.
--
-- -- Why this belongs in the database --------------------------------------------------------------
--
-- It cannot be checked on the client that starts the match. A player may read their OWN team's fleet
-- and nobody else's ("fleets select own team"), so the host physically cannot see whether the other
-- crews have placed anything - which is the whole reason a public `team_ready` mirror exists in the
-- first place. Only Postgres can see every fleet at once, so only Postgres can enforce this. Same
-- argument as deep_water_hides, and it holds for the same reason.
--
-- The client checks too (startBattle calls unplaced_fleets() before it does any work, so the host
-- gets a sentence naming the fleet rather than a raised exception), but that check is a courtesy.
-- This one is the rule.

-- ===========================================================================
--  A length that never throws
-- ===========================================================================
-- jsonb_array_length() raises on anything that isn't an array, and these columns are jsonb rather
-- than real arrays, so a row holding null - or an object, if anything ever wrote one - would abort
-- the check that exists to keep the match honest. -1 is returned instead: it is not a length any
-- fleet can legitimately have, so every comparison below fails safely rather than erroring.
create or replace function public.jsonb_len(p jsonb)
returns int
language sql
immutable
set search_path = public
as $$
  select case when jsonb_typeof(p) = 'array' then jsonb_array_length(p) else -1 end;
$$;

grant execute on function public.jsonb_len(jsonb) to anon, authenticated;

-- ===========================================================================
--  Which crews are not ready to be shot at
-- ===========================================================================
-- Returns the teams that have at least one player and whose fleet row is not a fleet: missing,
-- unconfirmed, unplaced, or shaped for a different board than the one about to be played.
--
-- The shape tests are not padding. A row can hold a full set of placements and still be wrong for
-- the room - a fleet placed on a 12x12 board and then resized has hulls hanging off the edge, and a
-- preset swap that keeps the ship count but changes the sizes (Classic [3,2,2] to Armada [3,3,2] on
-- 5x5) leaves ship_hits_remaining counting down the wrong hull, which is how a Submarine sank on its
-- second hit in RESTLESSCUTLASS. Every one of those is a fleet that cannot be fought fairly, so
-- every one of them stops a match here.
--
-- SECURITY DEFINER because it reads every fleet in the room, which is exactly what no caller is
-- allowed to do for themselves. It returns team NUMBERS and nothing else - not a placement, not a
-- count of hulls, not a hint of where anything is - so a curious player who calls it directly learns
-- only what the lobby already tells them out loud.
create or replace function public.unplaced_fleets(p_room_id uuid)
returns int[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_room  rooms%rowtype;
  v_ships int;
  v_cells int;
  v_team  int;
  v_fleet fleets%rowtype;
  v_out   int[] := '{}';
begin
  select * into v_room from rooms r where r.id = p_room_id;
  if not found then
    return v_out;
  end if;

  v_ships := public.jsonb_len(v_room.ship_defs);
  v_cells := v_room.board_size * v_room.board_size;

  for v_team in
    select distinct p.team
      from players p
     where p.room_id = p_room_id
       and p.team is not null
     order by 1
  loop
    select * into v_fleet
      from fleets f
     where f.room_id = p_room_id
       and f.team = v_team;

    if not found
       or not v_fleet.placement_confirmed
       or public.jsonb_len(v_fleet.placements) <> v_ships
       or public.jsonb_len(v_fleet.ship_hits_remaining) <> v_ships
       or public.jsonb_len(v_fleet.ship_sunk) <> v_ships
       or public.jsonb_len(v_fleet.ship_grid) <> v_cells
       or public.jsonb_len(v_fleet.ship_index_grid) <> v_cells
    then
      v_out := v_out || v_team;
    end if;
  end loop;

  return v_out;
end;
$$;

grant execute on function public.unplaced_fleets(uuid) to anon, authenticated;

-- ===========================================================================
--  The rule: no fleet, no battle
-- ===========================================================================
-- A trigger rather than a policy, for the same reason guard_board_perm and guard_player_team are
-- triggers: RLS cannot compare the old row to the new one, and this has to fire on one particular
-- transition rather than on the row as a whole.
--
-- Deliberately NOT `security definer`, also for the same reason as those two: inside a definer
-- function current_user is the function's owner, and the role check below would then pass for every
-- caller alive - the exemption would swallow the rule.
--
-- There is no is_admin() exemption here, which is a departure from the guards next to it. An admin
-- forcing a match to start over an empty fleet is not a power anybody needs. The fix for a crew
-- that hasn't placed is for them to place, and forcing the start is exactly the outcome this file
-- exists to prevent. The SQL editor (postgres) is still exempt, so a room that genuinely has to be shoved
-- forward by hand still can be, deliberately and with a record of it.
create or replace function public.guard_battle_start()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_unplaced int[];
begin
  -- Only the moment of entering battle. Every other update to the row - the winner, the seed, the
  -- team names, the balance record - goes straight through, including battle-to-battle rewrites.
  if new.status is distinct from 'battle' or old.status is not distinct from 'battle' then
    return new;
  end if;

  -- PostgREST switches to service_role for service-key requests (the edge functions); postgres and
  -- supabase_admin cover the SQL editor and any later migration.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  v_unplaced := public.unplaced_fleets(new.id);
  if array_length(v_unplaced, 1) is null then
    return new;
  end if;

  -- Named by number because this is the backstop and the database has no idea what anyone calls
  -- their fleet. startBattle() runs the same check first and says it in fleet names.
  raise exception 'Fleet(s) % have not placed their ships - a match cannot start over an empty board',
    array_to_string(v_unplaced, ', ');
end;
$$;

drop trigger if exists rooms_guard_battle_start on rooms;
create trigger rooms_guard_battle_start
  before update on rooms
  for each row execute function public.guard_battle_start();

comment on function public.unplaced_fleets(uuid) is
  'Teams in this room whose fleet is missing, unconfirmed, unplaced or shaped for a different board. Empty means every crew can be fought.';
