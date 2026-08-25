-- A fleet that is already in a match must never be cleared, reshaped, or unconfirmed.
--
-- -- What happened in SALTYLANTERN -----------------------------------------------------------------
--
-- Two crews, an hour and six minutes of play, and the winning fleet was never on the board. Mixed
-- fired thirty-six shots at it and missed thirty-six times, because there was nothing there to hit.
--
-- This is DEEPVOYAGE again, and the reason it came back is that the last fix aimed at the wrong
-- thing. 20260819010000 read the wreckage - a fleet row stamped for a board the room had stopped
-- being - and blamed ensureFleet() for stamping it at team-pick time and never rewriting it. So it
-- re-seeded every row at the top of placement and refused to start a battle over one that was still
-- wrong. Both of those are worth having. Neither was the bug.
--
-- ensureFleet() cannot do this: it is an upsert with ON CONFLICT DO NOTHING and has never once
-- overwritten a row. The writer was always resetOwnTeamState(), which blanks a fleet using the
-- `room` object the CALLING BROWSER happens to be holding:
--
--   ship_grid           = emptyGrid(room.board_size * room.board_size)
--   ship_hits_remaining = initialHitsRemaining(room.ship_defs)
--   placements          = null
--   placement_confirmed = false
--
-- and it is driven by a client-side effect that fires whenever THAT BROWSER believes the room is in
-- 'lobby' or 'placement'. Both halves of that are a client's opinion, and in SALTYLANTERN both were
-- out of date. The room had been created at the default 10x10; when the roster settled into a 2v2
-- the host's lobby quietly refitted it to 6x6 with a three-hull fleet (see LobbyPhase's roster sync,
-- which is reactive by design and needs no click). One client never caught up. It kept a 10x10 room
-- in 'lobby', watched a confirmed fleet arrive over realtime, read it as last match's leftovers -
-- the 'lobby' branch of that effect asks for no other evidence - and wrote a blank 10x10 fleet over
-- a confirmed 6x6 one, mid-battle. The row it left behind:
--
--   team 4:  placements = NULL   placement_confirmed = false
--            ship_grid  = 100 cells   ship_hits_remaining = [5,4,3,3,2]
--
-- in a 6x6 room fielding [4,2,2]. Same shape of wreckage as DEEPVOYAGE, same author, and every
-- guard shipped since looked straight past it - because they all fire before or at the start of the
-- battle, and this write lands a few hundred milliseconds after. Two independent server-side checks
-- had already passed on that exact fleet: balance-board refuses to deal unless every fleet reads
-- placement_confirmed, and it wrote a full balance report at 20:32:20.794; guard_battle_start ran
-- unplaced_fleets() at the status flip at 20:32:21.380 and let it through. The fleet was real. It
-- was deleted afterwards, by a browser that thought the match had not started yet.
--
-- -- What actually closes it -----------------------------------------------------------------------
--
-- Two things, and the first is the one that makes this permanent.
--
--   1. A trigger, below, that refuses to let any fleet lose its layout while its room is in
--      'battle' or 'finished'. It does not care what the client believes, which is the entire
--      point: the browsers that caused this are OBS sources, background tabs and phones holding
--      minutes-old state, and no amount of shipping new front-end code reaches them. A stale client
--      can now ask for this write for as long as it likes and be refused every time.
--
--   2. reset_team_fleet() / reset_room_fleets(), which move the blanking itself onto the server.
--      A caller no longer says what shape a blank fleet is - Postgres reads board_size and ship_defs
--      off the room and builds it from those - so a stale browser cannot stamp a fleet with a board
--      the room stopped being, which is the OTHER half of what went wrong and the half that leaves
--      the fossils. The client keeps its self-heal; it just no longer supplies the facts.
--
-- The rule is deliberately wider than the accident. Not "placements may not go null", but "nothing
-- about the layout may change once the shooting starts" - the hulls, their confirmation, and the
-- shape of all four arrays. A layout edited mid-match is cheating whether or not it ends up empty,
-- and there is no legitimate writer of any of it after the battle opens: from that moment the only
-- fleet columns a match touches are ship_hits_remaining and ship_sunk, which resolve_attack and the
-- legacy client path move on every shot and which this leaves alone.

-- ===========================================================================
--  Reading a room's status without depending on who is asking
-- ===========================================================================
-- The guard below is NOT security definer, for the same reason guard_battle_start isn't: inside a
-- definer function current_user is the owner, and the service-role exemption would then swallow the
-- rule for every caller alive. But it still has to read `rooms`, so the read is its own definer
-- function - the same split 20260819010000 uses for unplaced_fleets().
--
-- It leaks nothing: `rooms select` is `using (true)`, so a room's status is already world-readable
-- to anyone holding its id.
create or replace function public.room_status(p_room_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select r.status from rooms r where r.id = p_room_id;
$$;

grant execute on function public.room_status(uuid) to anon, authenticated;

-- ===========================================================================
--  The rule: a fleet in a match is finished being placed
-- ===========================================================================
create or replace function public.guard_fleet_reset()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  -- Nothing about the layout is moving. This is the hot path - every shot in every match resolves
  -- through an update that changes ship_hits_remaining and ship_sunk and nothing else - so it is
  -- first and it is cheap, and no match ever reaches the room read below.
  if new.placements is not distinct from old.placements
     and new.placement_confirmed is not distinct from old.placement_confirmed
     and public.jsonb_len(new.ship_grid) = public.jsonb_len(old.ship_grid)
     and public.jsonb_len(new.ship_index_grid) = public.jsonb_len(old.ship_index_grid)
     and public.jsonb_len(new.ship_hits_remaining) = public.jsonb_len(old.ship_hits_remaining)
     and public.jsonb_len(new.ship_sunk) = public.jsonb_len(old.ship_sunk)
  then
    return new;
  end if;

  -- PostgREST switches to service_role for the edge functions; postgres and supabase_admin cover the
  -- SQL editor and any later migration. It also covers the two reset functions below, which are
  -- security definer and therefore run as the owner - that is how "End match" can still blank a
  -- room's fleets from inside a live battle while a browser asking directly cannot.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  v_status := public.room_status(new.room_id);
  if v_status is distinct from 'battle' and v_status is distinct from 'finished' then
    return new;
  end if;

  -- No is_admin() exemption, matching guard_battle_start. Editing a fleet that is already being
  -- shot at is not a power anybody needs, and the SQL editor is still exempt for a room that
  -- genuinely has to be repaired by hand.
  raise exception
    'Fleet % is in a match that has already started - its layout cannot be cleared, reshaped or unconfirmed now',
    new.team;
end;
$$;

drop trigger if exists fleets_guard_reset on fleets;
create trigger fleets_guard_reset
  before update on fleets
  for each row execute function public.guard_fleet_reset();

-- ===========================================================================
--  A blank fleet, built from the room rather than from the caller
-- ===========================================================================
-- The shape comes off the room row every time, so there is no version of this that can write a
-- 10x10 fleet into a 6x6 room however stale the browser that asked for it.
--
-- NOT granted to anyone. Postgres grants EXECUTE to PUBLIC on new functions by default, and this one
-- is security definer with no authorization of its own - the two callers below own that. Revoked
-- explicitly rather than left to `create function` defaults, because getting this wrong would hand
-- every player in the world a button that wipes any fleet in any room.
create or replace function public.reseed_fleets(p_room_id uuid, p_team int default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room  rooms%rowtype;
  v_cells int;
  v_grid  jsonb;
  v_index jsonb;
  v_hits  jsonb;
  v_sunk  jsonb;
  v_rows  int;
begin
  select * into v_room from rooms r where r.id = p_room_id;
  if not found then
    return 0;
  end if;

  v_cells := v_room.board_size * v_room.board_size;

  -- emptyGrid(cells, false), emptyGrid(cells, -1), initialHitsRemaining(ship_defs) and
  -- emptyGrid(ships, false) from lib/battleshipLogic, in SQL. coalesce covers a zero-length board
  -- or an empty fleet, where jsonb_agg returns null rather than an empty array.
  select coalesce(jsonb_agg(false), '[]'::jsonb) into v_grid  from generate_series(1, v_cells);
  select coalesce(jsonb_agg(-1),    '[]'::jsonb) into v_index from generate_series(1, v_cells);
  select coalesce(jsonb_agg(d.value -> 'size' order by d.ord), '[]'::jsonb) into v_hits
    from jsonb_array_elements(v_room.ship_defs) with ordinality as d(value, ord);
  select coalesce(jsonb_agg(false), '[]'::jsonb) into v_sunk
    from jsonb_array_elements(v_room.ship_defs);

  update fleets f
     set ship_grid           = v_grid,
         ship_index_grid     = v_index,
         ship_hits_remaining = v_hits,
         ship_sunk           = v_sunk,
         placements          = null,
         placement_confirmed = false
   where f.room_id = p_room_id
     and (p_team is null or f.team = p_team);
  get diagnostics v_rows = row_count;

  -- The public mirror of the same fact. resetOwnTeamState has always written both together, and a
  -- ready flag outliving the fleet it belonged to is what a later start reads as "this crew is
  -- placed" - see the note on the team_ready delete in resetRoomToLobby.
  update team_ready t
     set ready = false, eliminated = false
   where t.room_id = p_room_id
     and (p_team is null or t.team = p_team);

  return v_rows;
end;
$$;

revoke execute on function public.reseed_fleets(uuid, int) from public;
revoke execute on function public.reseed_fleets(uuid, int) from anon, authenticated;

-- ===========================================================================
--  Clearing your own crew's board
-- ===========================================================================
-- The self-heal in useRoom, moved server-side. Returns false rather than raising when the room is
-- past placement: a stale client asking to tidy up a match that has since started is not an error
-- to put in front of anybody, it is simply a request with nothing behind it, and the honest answer
-- is to do nothing and say so.
create or replace function public.reset_team_fleet(p_room_id uuid, p_team int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select r.status into v_status from rooms r where r.id = p_room_id;
  if v_status is null then
    return false;
  end if;

  -- A blank fleet is only ever the right answer before anyone can shoot at it.
  if v_status not in ('lobby', 'placement') then
    return false;
  end if;

  if not exists (
    select 1 from players p
     where p.room_id = p_room_id
       and p.team = p_team
       and p.user_id = auth.uid()
  ) then
    raise exception 'Only this fleet''s own crew can clear it';
  end if;

  perform public.reseed_fleets(p_room_id, p_team);
  return true;
end;
$$;

grant execute on function public.reset_team_fleet(uuid, int) to anon, authenticated;

-- ===========================================================================
--  Clearing the whole room's boards
-- ===========================================================================
-- The host's two reset paths: opening placement, and ending a match. Allowed in any status on
-- purpose - "End match" runs while the room is still in 'battle' or 'finished', and blanking the
-- fleets is the whole point of it. It grants the host no power they did not already have, since
-- ending the match is theirs to call either way.
--
-- This also replaces a write that never worked as intended. beginPlacementPhase's room-wide re-seed
-- was deliberately unverified, because RLS lets the host read back only their own row - so a
-- rejection was indistinguishable from success. The row count comes back from inside the definer
-- function instead, where every row is visible.
create or replace function public.reset_room_fleets(p_room_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin()
     and not exists (
       select 1 from players host
        where host.room_id = p_room_id
          and host.user_id = auth.uid()
          and host.is_host
     )
  then
    raise exception 'Only the host can reset this room''s fleets';
  end if;

  return public.reseed_fleets(p_room_id, null);
end;
$$;

grant execute on function public.reset_room_fleets(uuid) to anon, authenticated;

comment on function public.reset_team_fleet(uuid, int) is
  'Blanks one crew''s fleet, shaped from the room itself. Refuses once the room is past placement.';
comment on function public.reset_room_fleets(uuid) is
  'Blanks every fleet in the room, shaped from the room itself. Host only; allowed in any phase.';
