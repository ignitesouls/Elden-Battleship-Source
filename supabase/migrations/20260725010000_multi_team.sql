-- Upgrades an existing EldenBattleship database from the 2-team-only design to
-- support any number of teams (2-9). Run this once in the SQL Editor of a
-- project that already has the original schema.sql applied.

alter table rooms drop column if exists team0_ready;
alter table rooms drop column if exists team1_ready;

create table if not exists team_ready (
  room_id uuid not null references rooms(id) on delete cascade,
  team int not null,
  ready boolean not null default false,
  eliminated boolean not null default false,
  primary key (room_id, team)
);

alter table team_ready enable row level security;

drop policy if exists "team_ready select" on team_ready;
create policy "team_ready select" on team_ready for select using (true);

drop policy if exists "team_ready upsert own team" on team_ready;
create policy "team_ready upsert own team" on team_ready for insert with check (
  exists (
    select 1 from players p
    where p.room_id = team_ready.room_id
      and p.team = team_ready.team
      and p.user_id = auth.uid()
  )
);

drop policy if exists "team_ready update own team" on team_ready;
create policy "team_ready update own team" on team_ready for update using (
  exists (
    select 1 from players p
    where p.room_id = team_ready.room_id
      and p.team = team_ready.team
      and p.user_id = auth.uid()
  )
);

-- Guarded because adding a table already in the publication is an error, not a no-op -
-- initial_schema.sql already adds team_ready when this runs on a fresh database.
do $$
begin
  alter publication supabase_realtime add table team_ready;
exception
  when duplicate_object then null;
end $$;
