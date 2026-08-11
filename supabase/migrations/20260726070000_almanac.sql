-- The Almanac: cross-match data that outlives the room pruner.
--
-- Both tables exist for the same reason match_participants does - `rooms`, `fleets` and
-- `attacks` are all deleted an hour after a room goes quiet, so anything you want to know about
-- the game *in aggregate* has to be copied somewhere durable at the moment a match ends.

-- --- where fleets actually get placed ------------------------------------
-- One row per team per match. Powers the placement heatmap: over enough games this shows
-- whether people really do hug the edges, or all pile into the middle.
create table if not exists match_fleets (
  id uuid primary key default gen_random_uuid(),
  match_key text not null,
  team int not null,
  board_size int not null,
  placements jsonb not null default '[]',
  ship_defs jsonb not null default '[]',
  finished_at timestamptz not null default now(),
  unique (match_key, team)
);

alter table match_fleets enable row level security;

create policy "match_fleets select" on match_fleets for select using (true);
create policy "match_fleets insert" on match_fleets for insert with check (true);

create index if not exists match_fleets_finished_idx on match_fleets (finished_at desc);

-- --- every shot ever fired -----------------------------------------------
-- One row per trigger-pull (NOT per attacks row - a single shot writes one attacks row per
-- opposing team, and counting those would inflate everything). Carries the boss name resolved
-- at write time, because the challenge layout is seeded from the room id: the same cell index
-- means a different boss in every room, so the name cannot be recovered later from the index.
create table if not exists match_events (
  id uuid primary key default gen_random_uuid(),
  match_key text not null,
  user_id uuid,
  nickname text not null,
  team int not null,
  cell_index int not null,
  challenge_name text,
  result text not null,
  -- Seconds from the moment firing opened, so timings are comparable across rooms with
  -- different preparation lengths.
  match_seconds int,
  board_size int not null,
  finished_at timestamptz not null default now(),
  unique (match_key, nickname, cell_index)
);

alter table match_events enable row level security;

create policy "match_events select" on match_events for select using (true);
create policy "match_events insert" on match_events for insert with check (true);

create index if not exists match_events_challenge_idx on match_events (challenge_name);
create index if not exists match_events_user_idx on match_events (user_id);
create index if not exists match_events_finished_idx on match_events (finished_at desc);
