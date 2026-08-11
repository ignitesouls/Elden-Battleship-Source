-- EldenBattleship web schema
-- Run this once in your Supabase project's SQL editor (Project > SQL Editor > New query).
--
-- Design notes:
--   * Players are anonymous (Supabase Anonymous Auth). Each browser session gets a
--     stable auth.uid() used to prove "which team am I" for row-level security.
--   * Ship positions live in `fleets`, readable/writable ONLY by players on that team.
--     Opponents genuinely cannot read your ship layout, even by inspecting network
--     traffic in devtools - Postgres enforces it, not the client.
--   * Attacks are resolved by the DEFENDING team's own browser: the attacker inserts
--     a pending row, any client on the defending team computes hit/miss against their
--     own (locally-visible) fleet and writes the result back. No server function needed.
--   * rooms/players hold no secret data, so their policies stay permissive.
--   * Any number of teams (2-9, matching the color palette) can play at once. Firing at a
--     cell attacks every OTHER active team simultaneously at that coordinate - one player
--     action, one row per opponent in `attacks`.

create extension if not exists pgcrypto;

-- --- rooms ---------------------------------------------------------------
create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  board_size int not null default 10,
  ship_defs jsonb not null default '[{"name":"Carrier","size":5},{"name":"Battleship","size":4},{"name":"Cruiser","size":3},{"name":"Submarine","size":3},{"name":"Destroyer","size":2}]',
  status text not null default 'lobby' check (status in ('lobby','placement','battle','finished')),
  winner_team int,
  created_at timestamptz not null default now()
);

alter table rooms enable row level security;

create policy "rooms select" on rooms for select using (true);
create policy "rooms insert" on rooms for insert with check (true);
create policy "rooms update" on rooms for update using (true);

-- --- players -------------------------------------------------------------
create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  nickname text not null,
  team int, -- null = spectator
  is_host boolean not null default false,
  joined_at timestamptz not null default now(),
  unique (room_id, user_id)
);

alter table players enable row level security;

create policy "players select" on players for select using (true);
create policy "players insert" on players for insert with check (user_id = auth.uid());
create policy "players update own" on players for update using (user_id = auth.uid());
create policy "players delete own" on players for delete using (user_id = auth.uid());
create policy "players delete by host" on players for delete using (
  exists (
    select 1 from players host
    where host.room_id = players.room_id
      and host.user_id = auth.uid()
      and host.is_host = true
  )
);

-- --- fleets (PRIVATE: ship positions) --------------------------------------
create table if not exists fleets (
  room_id uuid not null references rooms(id) on delete cascade,
  team int not null,
  ship_grid jsonb not null default '[]',        -- bool[]: true where a ship occupies the cell
  ship_index_grid jsonb not null default '[]',   -- int[]: which ship index occupies the cell (-1 = none)
  ship_hits_remaining jsonb not null default '[]', -- int[] per ship definition
  ship_sunk jsonb not null default '[]',         -- bool[] per ship definition
  placements jsonb,                              -- ShipPlacement[]
  placement_confirmed boolean not null default false,
  primary key (room_id, team)
);

alter table fleets enable row level security;

create policy "fleets select own team" on fleets for select using (
  exists (
    select 1 from players p
    where p.room_id = fleets.room_id
      and p.team = fleets.team
      and p.user_id = auth.uid()
  )
);

-- Spectators (a player row in this room with team is null) may read every fleet, so the
-- spectator view can draw ship positions.
--
-- ⚠ This means anyone who joins a room and picks "Spectator" can see every team's ships -
-- including a competitor using a second browser profile. That is inherent to the feature. To
-- restrict it to post-match only, add:
--   and exists (select 1 from rooms r where r.id = fleets.room_id and r.status = 'finished')
create policy "fleets select by spectator" on fleets for select using (
  exists (
    select 1 from players p
    where p.room_id = fleets.room_id
      and p.user_id = auth.uid()
      and p.team is null
  )
);

-- Reveals every fleet once the match is over, for the post-match report. Not exploitable: it
-- only opens at status = 'finished', and a rematch resets status to 'lobby' and wipes placements.
create policy "fleets select after match" on fleets for select using (
  exists (
    select 1 from rooms r
    where r.id = fleets.room_id
      and r.status = 'finished'
  )
  and exists (
    select 1 from players p
    where p.room_id = fleets.room_id
      and p.user_id = auth.uid()
  )
);

create policy "fleets upsert own team" on fleets for insert with check (
  exists (
    select 1 from players p
    where p.room_id = fleets.room_id
      and p.team = fleets.team
      and p.user_id = auth.uid()
  )
);

create policy "fleets update own team" on fleets for update using (
  exists (
    select 1 from players p
    where p.room_id = fleets.room_id
      and p.team = fleets.team
      and p.user_id = auth.uid()
  )
);

-- Lets the host reset every team's fleet at once (resetRoomToLobby / "End match"). Without
-- this, only the host's own team's fleet actually got cleared - every other team's old ship
-- placements and hit/sunk state silently survived a "reset" because the write was rejected.
create policy "fleets reset by host" on fleets for update using (
  exists (
    select 1 from players host
    where host.room_id = fleets.room_id
      and host.user_id = auth.uid()
      and host.is_host = true
  )
);

-- --- team_ready (PUBLIC: non-sensitive mirror of fleets.placement_confirmed) -----
-- A team's "are we ready" flag isn't secret, but the fact that only that team can write
-- fleets means no one else could ever read it there. Mirrored here, publicly readable,
-- so every other team can tell when placement is done without touching ship_grid.
create table if not exists team_ready (
  room_id uuid not null references rooms(id) on delete cascade,
  team int not null,
  ready boolean not null default false,
  -- "All our ships are sunk" - not sensitive by itself (unlike WHERE they were), so it's
  -- safe to publish here. Lets any client compute "only one team left" without needing
  -- to see anyone's ship_grid.
  eliminated boolean not null default false,
  primary key (room_id, team)
);

alter table team_ready enable row level security;

create policy "team_ready select" on team_ready for select using (true);

create policy "team_ready upsert own team" on team_ready for insert with check (
  exists (
    select 1 from players p
    where p.room_id = team_ready.room_id
      and p.team = team_ready.team
      and p.user_id = auth.uid()
  )
);

create policy "team_ready update own team" on team_ready for update using (
  exists (
    select 1 from players p
    where p.room_id = team_ready.room_id
      and p.team = team_ready.team
      and p.user_id = auth.uid()
  )
);

-- No delete policy existed at all before, for anyone - resetRoomToLobby's cleanup delete
-- always silently removed 0 rows, so stale ready/eliminated flags survived every "reset".
create policy "team_ready delete by host" on team_ready for delete using (
  exists (
    select 1 from players host
    where host.room_id = team_ready.room_id
      and host.user_id = auth.uid()
      and host.is_host = true
  )
);

-- --- attacks (public log; resolved by the defending team's client) -------
create table if not exists attacks (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  cell_index int not null,
  attacker_team int not null,
  defender_team int not null,
  -- Who actually pulled the trigger, for the battle feed. Nullable so an attack survives the
  -- player leaving, and so rows predating this column still load.
  attacker_player_id uuid references players(id) on delete set null,
  result text not null default 'pending' check (result in ('pending','miss','hit','sunk')),
  sunk_ship_name text,
  sunk_ship_size int,
  sunk_start_row int,
  sunk_start_col int,
  sunk_horizontal boolean,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table attacks enable row level security;

-- Postgres only includes primary-key columns in a DELETE's replicated "old" row by default.
-- `id` alone is the PK here, but the client filters this table's realtime channel by
-- room_id - without FULL identity, bulk-deleting a room's attacks (e.g. resetting to lobby)
-- wouldn't carry enough data for that filter to match, and the DELETE events would silently
-- never reach clients, leaving stale hit/miss markers on screen after a match "resets".
alter table attacks replica identity full;

create policy "attacks select" on attacks for select using (true);

-- Required for the host's "End match"/"Play again" reset to clear the previous match's shots.
-- Without a delete policy, Postgres RLS silently deletes zero rows and reports no error, so
-- the reset looks like it succeeded while the old hits stay on everyone's board. Permissive
-- to match `rooms`, which is likewise room-scoped and freely writable by anyone in the game.
create policy "attacks delete" on attacks for delete using (true);

create policy "attacks insert by attacker" on attacks for insert with check (
  exists (
    select 1 from players p
    where p.room_id = attacks.room_id
      and p.team = attacks.attacker_team
      and p.user_id = auth.uid()
  )
);

-- The match-start marker (rooms.ts startBattle()) inserts a sentinel row with attacker_team = -1,
-- which no real player ever has as their team, so the policy above always rejects it. Any room
-- member may insert this specific sentinel; it carries no ship data.
create policy "attacks insert start marker" on attacks for insert with check (
  cell_index = -1
  and exists (
    select 1 from players p
    where p.room_id = attacks.room_id
      and p.user_id = auth.uid()
  )
);

create policy "attacks resolved by defender" on attacks for update using (
  exists (
    select 1 from players p
    where p.room_id = attacks.room_id
      and p.team = attacks.defender_team
      and p.user_id = auth.uid()
  )
);

-- --- room cap + reaping abandoned rooms ---------------------------------
-- Rooms with no activity for an hour are deleted (cascading to their players/fleets/
-- team_ready/attacks), and at most 15 rooms may exist at once. The cap prunes before it
-- rejects, so a backlog of dead rooms can never permanently block new games.
--
-- Activity is computed on the fly (newest attack, newest player join, else the room's own
-- created_at) rather than via a last_activity_at column maintained by triggers: `rooms` is in
-- the realtime publication, so touching it per attack would broadcast a room UPDATE to every
-- client on every shot and serialize concurrent shots on a single row.
create or replace function public.prune_stale_rooms()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  with activity as (
    select
      r.id,
      r.status,
      greatest(
        r.created_at,
        coalesce((select max(a.created_at) from attacks a where a.room_id = r.id), r.created_at),
        coalesce((select max(p.joined_at)  from players p where p.room_id = r.id), r.created_at)
      ) as last_active
    from rooms r
  ),
  dead as (
    delete from rooms r
    using activity act
    where act.id = r.id
      and act.last_active < case
            -- A finished match is already over, so it doesn't need the full idle window.
            when act.status = 'finished' then now() - interval '10 minutes'
            else now() - interval '1 hour'
          end
    returning 1
  )
  select count(*) into removed from dead;

  return removed;
end;
$$;

revoke all on function public.prune_stale_rooms() from public;

create or replace function public.enforce_room_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  max_rooms constant integer := 15;
  room_count integer;
begin
  perform public.prune_stale_rooms();

  select count(*) into room_count from rooms;

  if room_count >= max_rooms then
    -- check_violation (23514), NOT unique_violation (23505): createRoom() retries on 23505 for
    -- room-code collisions, and a capacity error must break out of that loop immediately.
    raise exception
      'All % game rooms are currently in use. Rooms are cleared automatically after an hour of inactivity - try again in a bit, or join an existing room with its code.',
      max_rooms
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists rooms_enforce_limit on rooms;
create trigger rooms_enforce_limit
  before insert on rooms
  for each row
  execute function public.enforce_room_limit();

-- --- deep_hides (PRIVATE until fired upon) -------------------------------
-- What is hiding in the water: the white whale, Cthulhu's tentacles, the Flying Dutchman, four
-- bottles and Alexander (see src/lib/deepWater.ts). Rolled once by roll_deep_water() below, at the
-- moment every fleet has confirmed and before a shot is fired, out of the cells NO fleet occupies.
--
-- It is done here rather than in the client because no client is allowed to know the answer: a
-- player reads their own fleet and nobody else's. The client-side version placed these by inference
-- from the attack log and got it wrong in one specific, unfixable way - a shot writes one row per
-- OPPONENT, so a miss never said anything about the fleet that fired it, and creatures duly turned
-- up on squares the finding crew had a ship on.
create table if not exists deep_hides (
  room_id uuid not null references rooms(id) on delete cascade,
  cell_index int not null,
  creature text not null check (creature in ('whale', 'tentacle', 'dutchman', 'bottle', 'alexander')),
  -- One in five: this square is the decoy rather than the thing - Laboon on a 'whale' square,
  -- Patches on a 'tentacle' square. Rolled with the position and just as secret.
  decoy boolean not null default false,
  primary key (room_id, cell_index)
);

alter table deep_hides enable row level security;

-- Revealed one square at a time, and only by firing at it. This is the whole secrecy model, and it
-- is a property of the data rather than a policy the client is trusted to follow: an unfound
-- creature's row is invisible to every client, so there is nothing to read out of devtools.
--
-- Deliberately not scoped to the firing team - a caster's overlay holds no player row and must still
-- see finds land. Who is SHOWN what, among rows a client can read, is decided by deepMarks().
drop policy if exists "deep_hides select once fired at" on deep_hides;
create policy "deep_hides select once fired at" on deep_hides for select using (
  exists (
    select 1 from attacks a
    where a.room_id = deep_hides.room_id
      and a.cell_index = deep_hides.cell_index
      and a.result <> 'pending'
  )
);

-- Cleared with the attack log on a reset (resetRoomToLobby). Permissive to match "attacks delete".
drop policy if exists "deep_hides delete" on deep_hides;
create policy "deep_hides delete" on deep_hides for delete using (true);

-- No insert or update policy exists on purpose: the roll is SECURITY DEFINER and bypasses RLS, and
-- nothing else may write here. A client that could plant a creature could prove a square empty.

-- Called from startBattle(). Returns how many squares it hid something on, so the client can tell
-- "board too small" from "this project has not run the migration".
create or replace function roll_deep_water(p_room_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_size      int;
  v_cells     int;
  v_free      int[];
  v_tentacles int;
  v_extras    boolean;
  v_placed    int;
begin
  select board_size into v_size from rooms where id = p_room_id;
  if v_size is null then
    return 0;
  end if;
  v_cells := v_size * v_size;

  -- Never mid-match: a re-roll would move a creature off a square somebody has been told is empty.
  if exists (select 1 from attacks where room_id = p_room_id and cell_index >= 0) then
    return (select count(*)::int from deep_hides where room_id = p_room_id);
  end if;

  -- Never while a hull can still move. Stale fleet rows for teams nobody is on are ignored.
  if exists (
    select 1 from fleets f
    where f.room_id = p_room_id
      and not f.placement_confirmed
      and exists (select 1 from players p where p.room_id = p_room_id and p.team = f.team)
  ) then
    return 0;
  end if;

  delete from deep_hides where room_id = p_room_id;

  -- Every cell no fleet occupies, shuffled. ship_grid is a flat jsonb bool array by cell index.
  select coalesce(array_agg(c order by random()), '{}')
    into v_free
  from generate_series(0, v_cells - 1) as c
  where not exists (
    select 1 from fleets f
    where f.room_id = p_room_id
      and coalesce(f.ship_grid -> c, 'false'::jsonb) = 'true'::jsonb
  );

  -- Mirrors tentacleCount()/hidesExtras() in src/lib/deepWater.ts, which still computes how many
  -- tentacles a board HAS - the client cannot count rows it is not allowed to read. The two must
  -- agree or Cthulhu wakes at the wrong number; scripts/check-deep-water.ts checks this file for it.
  v_extras := v_cells >= 64;
  v_tentacles := case when v_extras then least(6, greatest(3, round(v_cells * 0.04)::int)) else 0 end;

  -- Ordered by `ord`, so on a board with barely any open water the whale is hidden first.
  with wanted(ord, creature, n) as (
    values (1, 'whale'::text, 1),
           (2, 'tentacle', v_tentacles),
           (3, 'dutchman', case when v_extras then 3 else 0 end),
           (4, 'bottle', case when v_extras then 4 else 0 end),
           (5, 'alexander', case when v_extras then 1 else 0 end)
  ),
  slots as (
    select w.creature, row_number() over (order by w.ord, g.i) as slot
    from wanted w
    cross join lateral generate_series(1, w.n) as g(i)
  )
  insert into deep_hides (room_id, cell_index, creature, decoy)
  select p_room_id,
         v_free[slot::int],
         creature,
         creature in ('whale', 'tentacle') and random() < 0.2
  from slots
  where slot <= coalesce(array_length(v_free, 1), 0);

  get diagnostics v_placed = row_count;
  return v_placed;
end;
$$;

revoke all on function roll_deep_water(uuid) from public;
grant execute on function roll_deep_water(uuid) to anon, authenticated;

-- --- realtime -----------------------------------------------------------
-- Enables live sync: lobby updates, ship-placement confirmations, attacks landing.
alter publication supabase_realtime add table rooms, players, fleets, team_ready, attacks;
