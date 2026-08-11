-- Career stats: durable player profiles and a per-match participation record.
--
-- Why this needs new tables rather than reading what's already there: `match_reports.summary`
-- is opaque JSON (fine for replaying one recap, useless for aggregating across hundreds), and
-- the per-player id inside it is `players.id` - a per-ROOM row that gets deleted outright when
-- the room pruner runs an hour later. So today there is no way to say "these two results belong
-- to the same person". These tables fix exactly that: a stable identity, and one flat, queryable
-- row per player per match.

-- --- profiles ------------------------------------------------------------
-- Keyed on auth.users.id, which for a Twitch sign-in is stable across devices and cache clears.
-- Publicly readable because a leaderboard is public by definition; only the owner may write it.
create table if not exists profiles (
  id uuid primary key,
  twitch_id text unique,
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "profiles select" on profiles for select using (true);
create policy "profiles insert own" on profiles for insert with check (id = auth.uid());
create policy "profiles update own" on profiles for update using (id = auth.uid());

-- --- match_participants --------------------------------------------------
-- One row per player per finished match. Deliberately denormalised and free of foreign keys:
--
--  * No FK to rooms/players - those are deleted by the pruner, and career history must outlive
--    them. That is the whole point of this table.
--  * No FK to profiles either. Rows are written for anonymous players too, and a profile may
--    not exist yet at write time; a hard reference would make the insert fail rather than
--    degrade. `user_id` is stored raw and joined to profiles only when displaying.
--
-- Aggregation keys on user_id when present, falling back to nickname. Two different anonymous
-- players who both type "Ahab" will therefore merge into one career - unavoidable without a
-- login, and precisely the ambiguity signing in with Twitch removes.
create table if not exists match_participants (
  id uuid primary key default gen_random_uuid(),
  match_key text not null,
  user_id uuid,
  nickname text not null,
  team int not null,
  won boolean not null default false,
  draw boolean not null default false,
  shots int not null default 0,
  hits int not null default 0,
  misses int not null default 0,
  sunk int not null default 0,
  team_ships_lost int not null default 0,
  awards jsonb not null default '[]',
  room_code text,
  finished_at timestamptz not null default now(),
  -- Every client in the room writes the full roster when a match ends; this collapses those
  -- duplicate writes into one row each, the same way match_reports.match_key does.
  unique (match_key, nickname, team)
);

alter table match_participants enable row level security;

create policy "match_participants select" on match_participants for select using (true);
create policy "match_participants insert" on match_participants for insert with check (true);

create index if not exists match_participants_user_idx on match_participants (user_id);
create index if not exists match_participants_key_idx on match_participants (match_key);
create index if not exists match_participants_finished_idx on match_participants (finished_at desc);

-- Note: deliberately NOT added to the pruner. match_reports expire after 30 days because they
-- are bulky prose; these rows are a few dozen bytes each and are the entire career record, so
-- deleting them would silently reset everyone's stats.
