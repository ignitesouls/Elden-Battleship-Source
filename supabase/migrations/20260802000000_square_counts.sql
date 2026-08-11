-- --- square_counts (TEAM-PRIVATE: per-player tallies on board squares) ----------
--
-- The board's objective squares ask for a number of things - "Complete 3 Tunnels or Precipice
-- Dungeons in Different Regions" is a square a fleet is part-way through for most of a match. The
-- wheel-driven counter recorded that, but only in the counting player's own browser, so a team
-- working the same square had no way to see that a crewmate had already done two of the three.
--
-- One row per (player, square). Kept per-player rather than summed into one number per team: who
-- did what is exactly the thing a team needs to divide the work, and a single shared integer two
-- people can both edit is a lost-update race with no way to tell whose number won.
create table if not exists public.square_counts (
  room_id    uuid not null references public.rooms(id) on delete cascade,
  player_id  uuid not null references public.players(id) on delete cascade,
  -- Denormalised from players so the select policy can scope by team without a join per row, and
  -- so a count keeps the team it was made for if that player later switches fleets.
  team       int  not null,
  cell_index int  not null,
  tally      int  not null default 0,
  updated_at timestamptz not null default now(),
  primary key (room_id, player_id, cell_index)
);

create index if not exists square_counts_room_team_idx on public.square_counts (room_id, team);

alter table public.square_counts enable row level security;

-- Same team only. A tally is a deduction about the board - "we have two of the three" - and an
-- opponent reading it learns both what you are working on and how far along you are. This is the
-- same shape as "fleets select own team".
create policy "square_counts select own team" on public.square_counts for select using (
  exists (
    select 1 from public.players p
    where p.room_id = square_counts.room_id
      and p.team = square_counts.team
      and p.user_id = auth.uid()
  )
);

-- Spectators (a player row in this room with team is null) read every fleet's tallies, so the
-- spectator view can draw the counters each crew has on their own boards. A caster following a
-- match needs the working-out as much as the shots: "they're two of three into the tunnels" is what
-- explains a fleet sitting on a square instead of firing.
--
-- ⚠ Exactly the trade "fleets select by spectator" makes, and it has to be made the same way or the
-- feature doesn't exist: anyone who joins a room and picks Spectator can read this, including a
-- competitor on a second browser profile. To restrict it to post-match only, add:
--   and exists (select 1 from rooms r where r.id = square_counts.room_id and r.status = 'finished')
create policy "square_counts select by spectator" on public.square_counts for select using (
  exists (
    select 1 from public.players p
    where p.room_id = square_counts.room_id
      and p.user_id = auth.uid()
      and p.team is null
  )
);

-- You may only write your OWN counts, and only onto the team you are actually on. Both halves
-- matter: without the player_id check anyone in the room could forge a crewmate's tally, and
-- without the team check they could plant one on a team they had just left.
create policy "square_counts insert own" on public.square_counts for insert with check (
  exists (
    select 1 from public.players p
    where p.id = square_counts.player_id
      and p.room_id = square_counts.room_id
      and p.team = square_counts.team
      and p.user_id = auth.uid()
  )
);

create policy "square_counts update own" on public.square_counts for update using (
  exists (
    select 1 from public.players p
    where p.id = square_counts.player_id
      and p.room_id = square_counts.room_id
      and p.user_id = auth.uid()
  )
);

-- Own rows (the "clear my notes" button) and the host's reset, which has to clear everyone's.
create policy "square_counts delete own" on public.square_counts for delete using (
  exists (
    select 1 from public.players p
    where p.id = square_counts.player_id
      and p.room_id = square_counts.room_id
      and p.user_id = auth.uid()
  )
);

create policy "square_counts delete by host" on public.square_counts for delete using (
  exists (
    select 1 from public.players host
    where host.room_id = square_counts.room_id
      and host.user_id = auth.uid()
      and host.is_host = true
  )
);

-- Realtime, so a crewmate's tally appears on your board as they spin it rather than on your next
-- refresh. Guarded because adding a table already in the publication is an error, not a no-op.
do $$
begin
  alter publication supabase_realtime add table public.square_counts;
exception
  when duplicate_object then null;
end $$;
