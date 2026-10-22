-- Two reads that were slowing the auto-fire replies the in-game overlay waits on.
--
-- -- archive_revision ---------------------------------------------------------------------------
--
-- battle-ratings decides whether its stored snapshot is stale by fingerprinting the archive on every
-- request. That fingerprint was counts and sums over match_events and match_participants: a full read
-- of the shot archive (88 MB by October 2026) every time anyone opened a recap or the ratings board.
-- It averaged 1.3s, peaked at 21s and was 41% of all database time - and a match ending sends every
-- player to their recap at once, right when the overlay is still polling auto-fire.
--
-- Now every write to a table the ratings are computed from bumps one counter, and the fingerprint is
-- that counter plus the rating code's version. Same freshness (an archive, a void or unvoid, an admin
-- deleting or re-timing a shot, a maintenance script) for the price of reading one row. Statement
-- triggers, so a whole archive is one bump, not one per shot.
--
-- -- autofire_pbs -------------------------------------------------------------------------------
--
-- The overlay's PB line is a captain's bests on this board and fleet, worked out once per match. The
-- auto-fire function kept that in memory, but Supabase runs many short-lived copies of it, so most
-- polls landed on a copy that had never seen the captain and read their whole career again: 13,305
-- times by October 2026, against a few hundred matches. Kept here, one copy computes it and the rest
-- read one row.
--
-- The key is the one the function always used: captain, room, the match's start marker, square set,
-- board size and fleet. A replayed room has a new start marker, so a row never outlives its match in
-- practice; the function deletes rows over a day old whenever it writes one, so nothing needs a sweep.

create table if not exists public.archive_revision (
  id boolean primary key default true check (id),
  revision bigint not null default 0
);

insert into public.archive_revision (id, revision) values (true, 0) on conflict (id) do nothing;

comment on table public.archive_revision is
  'One counter, bumped by any write to a table battle ratings are computed from. battle-ratings fingerprints its snapshot with it.';

-- Security definer: archive_match, the admin tools and the void triggers all write these tables, under
-- whichever role called them, and every one of them has to be able to bump the counter.
create or replace function public.bump_archive_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.archive_revision set revision = revision + 1 where id;
  return null;
end;
$$;

revoke all on function public.bump_archive_revision() from public, anon, authenticated;

do $$
declare
  t text;
begin
  -- match_board_sources, the third thing a recompute reads, is a view over match_events.
  foreach t in array array['match_events', 'match_participants', 'voided_matches'] loop
    execute format('drop trigger if exists bump_archive_revision on public.%I', t);
    execute format(
      'create trigger bump_archive_revision after insert or update or delete or truncate on public.%I '
      'for each statement execute function public.bump_archive_revision()', t);
  end loop;
end;
$$;

create table if not exists public.autofire_pbs (
  cache_key text primary key,
  -- PersonalBests as the auto-fire function builds it: hits, sunk, shots, accuracyRatio, pace.
  bests jsonb not null,
  computed_at timestamptz not null default now()
);

comment on table public.autofire_pbs is
  'Each captain''s PB line for the match they are in, written and read only by the auto-fire Edge Function. Safe to empty: the next poll rebuilds it.';

-- Nobody reads or writes these over the API. The functions connect to the database directly, as the
-- owner, so RLS with no policies plus revoked grants leaves them reachable by those functions alone.
alter table public.archive_revision enable row level security;
revoke all on public.archive_revision from anon, authenticated;
alter table public.autofire_pbs enable row level security;
revoke all on public.autofire_pbs from anon, authenticated;
