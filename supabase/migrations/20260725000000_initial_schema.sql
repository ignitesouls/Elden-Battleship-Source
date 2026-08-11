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

create policy "attacks resolved by defender" on attacks for update using (
  exists (
    select 1 from players p
    where p.room_id = attacks.room_id
      and p.team = attacks.defender_team
      and p.user_id = auth.uid()
  )
);

-- --- realtime -----------------------------------------------------------
-- Enables live sync: lobby updates, ship-placement confirmations, attacks landing.
alter publication supabase_realtime add table rooms, players, fleets, team_ready, attacks;
