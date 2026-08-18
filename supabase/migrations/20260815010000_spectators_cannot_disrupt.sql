-- Makes "anyone may watch" survive the front page publishing every live battle's room code.
--
-- Until now a room code was a shared secret. Not much of one - it was read aloud on stream - but
-- the write policies were written on the assumption that everyone holding one had been let in on
-- purpose, so "any player in the room" was used as a rough stand-in for "somebody the room trusts".
-- The "Current battles" list on the front page ends that: the codes are now published to everybody,
-- and a stranger can walk into a live match with two clicks. Which is the point - but it means the
-- stand-in has to be replaced with the real thing wherever it was carrying weight.
--
-- The rule this migration enforces is the one that was always intended: a spectator may READ
-- everything about a match and CHANGE nothing about it.
--
-- Nothing here narrows what anyone can see. Every read policy is left exactly as it was.

-- ===========================================================================
--  1. Rooms: a spectator may not end, reset, rename or resize a match
-- ===========================================================================
-- "rooms update by player" (lock_down_writes) allows any player in the room, spectators included.
-- With published codes that is: set status='finished' with a winner of your choosing, roll the seed
-- mid-placement, rename both fleets, or resize the board out from under two placed fleets.
--
-- Scoped to people with a stake in the match - anyone holding a fleet, plus the host, who runs the
-- room whether or not they are playing (Room.tsx supports a host who is spectating, and they keep
-- every host power). The one thing lost is that a spectator can no longer be the client that writes
-- status='finished' when the last fleet goes down; every surviving crew member still can, and
-- useRoom no longer asks spectators to try.
drop policy if exists "rooms update by player" on rooms;
create policy "rooms update by crew" on rooms for update using (
  exists (
    select 1 from players p
     where p.room_id = rooms.id
       and p.user_id = auth.uid()
       and (p.team is not null or p.is_host)
  )
  or public.is_admin()
);

-- ===========================================================================
--  2. Players: you cannot walk into a battle and take a fleet
-- ===========================================================================
-- This is the one that mattered most, and the least obvious. "players update own" lets you write
-- your own row, and `team` is a column on that row - so a spectator could simply PATCH themselves
-- onto a fleet mid-battle. That is not a cosmetic problem: being on a team is what every other
-- policy in the schema keys off. One PATCH and the stranger can fire (attacks insert by attacker),
-- overwrite that fleet's ship placements (fleets update own team), mark it ready or eliminated
-- (team_ready), and write the room row (above). Every lock on this list opens with that one key.
--
-- The UI only ever offers the team picker in the lobby and on the post-match screen, so this
-- forbids nothing anybody can currently do by hand - it just stops it being possible by URL.
--
-- A trigger rather than a policy because RLS cannot compare the old row to the new one: USING sees
-- the row as it was, WITH CHECK sees it as it will be, and neither can say "this column did not
-- change". Same pattern, and the same invoker-not-definer reasoning, as guard_board_perm on rooms:
-- inside a SECURITY DEFINER function current_user is the owner, so the admin check below would pass
-- for every caller alive and the guard would wave through what it exists to stop.
create or replace function public.guard_player_team()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  if new.team is not distinct from old.team then
    return new;
  end if;

  -- The SQL editor, a later migration, and the edge functions' service key.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  select status into v_status from rooms where id = new.room_id;

  -- Lobby: fleets are being picked. Finished: the recap is up and crews reshuffle for the next
  -- match (Room.tsx's FinishedView offers the picker there deliberately, so a rematch doesn't have
  -- to wait on the host resetting the room). Placement and battle are the two states where the
  -- fleets are settled and a change of sides is not a choice anyone is entitled to make.
  if v_status in ('lobby', 'finished') then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  raise exception 'Fleets are settled once a match is under way';
end;
$$;

drop trigger if exists players_guard_team on players;
create trigger players_guard_team
  before update on players
  for each row execute function public.guard_player_team();

-- claim_player_slot() (rejoin codes) is untouched by this: it takes over an existing row by writing
-- user_id, and that row already holds the team it is being handed back. The team does not change,
-- so the trigger returns on its first line. Rejoining mid-battle still works.

-- ===========================================================================
--  3. The match clock: only the host may plant a start marker
-- ===========================================================================
-- "attacks insert start marker" allows any player in the room to insert the cell_index = -1 sentinel
-- that the entire match clock is measured from. Insert a second one mid-battle and every client's
-- STARTING / PREPARATION / MATCH reading jumps back to zero - and because the archived match key is
-- built from the earliest marker's timestamp, so does the record the match files afterwards.
--
-- Only startBattle() ever writes one, and Room.tsx only calls it from the host's client, so
-- host-only costs nothing legitimate.
drop policy if exists "attacks insert start marker" on attacks;
create policy "attacks insert start marker" on attacks for insert with check (
  cell_index = -1
  and (
    exists (
      select 1 from players p
       where p.room_id = attacks.room_id
         and p.user_id = auth.uid()
         and p.is_host
    )
    or public.is_admin()
  )
);

-- ===========================================================================
--  4. Deep water: the hiding places are not anybody's to clear
-- ===========================================================================
-- `deep_hides delete` is `using (true)` - not "any player in the room", but literally anyone with
-- the anon key, room code or no room code. Clearing them mid-match deletes what is hiding in the
-- water before the crews can find it. It is open at all only because resetRoomToLobby() has to wipe
-- the previous match's hides, and that is the host's button, exactly like the attack log beside it.
-- Guarded, unlike the sections above: deep_hides arrives with its own migration, and `drop policy
-- if exists` on a table that isn't there is an error rather than a no-op - which would abort this
-- whole file on a project that hasn't run the deep-water one yet.
do $$
begin
  if to_regclass('public.deep_hides') is null then
    return;
  end if;

  drop policy if exists "deep_hides delete" on deep_hides;
  create policy "deep_hides delete by host" on deep_hides for delete using (
    exists (
      select 1 from players p
       where p.room_id = deep_hides.room_id
         and p.user_id = auth.uid()
         and p.is_host
    )
    or public.is_admin()
  );
end
$$;

-- ===========================================================================
--  5. Hosting cannot be taken by someone who just walked in
-- ===========================================================================
-- claim_room_host() checks only that you are in the room. Every restriction above is host-shaped,
-- so without this the whole migration has a two-click bypass: watch a listed battle, claim the
-- room, then end it.
--
-- The takeover is a real feature and must survive - a host who drops leaves a room nobody can end,
-- restart or moderate, and the person who notices is often a spectator (the caster is usually the
-- only one still watching, which is exactly why the prompt appears on the spectator view).
--
-- So the line drawn is arrival, not role: you may take over a room you were in BEFORE the match
-- started. That admits the caster who has been there since the lobby and excludes the stranger who
-- arrived from the front page ten minutes into the battle - which is precisely the distinction the
-- published list creates. A room with no host at all stays claimable by anyone in it, because an
-- unmanageable room is a worse outcome than a rude one.
create or replace function public.claim_room_host(p_player_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room    uuid;
  v_joined  timestamptz;
  v_started timestamptz;
begin
  select room_id, created_at into v_room, v_joined
    from players
   where id = p_player_id and user_id = auth.uid();
  if v_room is null then return false; end if;

  -- cell_index = -1 is the match-start marker (MATCH_START_MARKER in lib/matchTime.ts). Null means
  -- no match has started in this room yet, so there is no "during" to have arrived in.
  select min(created_at) into v_started
    from attacks where room_id = v_room and cell_index = -1;

  if v_started is not null
     and v_joined > v_started
     and not public.is_admin()
     and exists (select 1 from players where room_id = v_room and is_host)
  then
    return false;
  end if;

  update players set is_host = false where room_id = v_room and is_host;
  update players set is_host = true  where id = p_player_id;
  return true;
end;
$$;

grant execute on function public.claim_room_host(uuid) to anon, authenticated;
