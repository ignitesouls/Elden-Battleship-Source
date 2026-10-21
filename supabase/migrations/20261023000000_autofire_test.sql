-- Auto-marking test: a fake two-square game a player runs from the OBS & auto-marking page to prove
-- the game mod, their token and the website are all talking before a real match depends on it.
--
-- -- What it is ----------------------------------------------------------------------------------
--
-- No room, no fleet, no opponent, no attacks rows. While a test is running and the player is in no
-- live match, the auto-fire edge function answers the mod's polls from this row instead of refusing
-- with `not_in_match`: it records the first time it sees either test boss's flag, and replies with a
-- fake clock and tally so the in-game overlay behaves as it would in a match. The board is fixed -
-- Tree Sentinel (Church of Elleh) and Beastman of Farum Azula (Groveside Cave), always the same two
-- cells - and lives in the edge function, not here.
--
-- Nothing in it touches stats, recaps, ratings or the archive, which is the point: a test must never
-- show up as a match anywhere.
--
-- -- Why its own table, not columns on ingest_tokens ---------------------------------------------
--
-- ingest_tokens holds a secret and its policies are written around that. It is also deleted and
-- re-inserted when a player replaces their token, which would wipe a test mid-run.
--
-- -- Lifetime ------------------------------------------------------------------------------------
--
-- One row per player, overwritten by each new test. The edge function only honours a row for ten
-- minutes after started_at (AUTOFIRE_TEST_MINUTES there), so a stale row is inert and needs no sweep.

create table if not exists public.autofire_tests (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  started_at    timestamptz not null default now(),
  -- Last poll the edge function answered from this test: "is the mod reaching us at all?"
  last_seen_at  timestamptz,
  -- tooltip -> { "at": iso kill time, "phase": "preparation" | "match" }. A kill first seen during the
  -- preparation countdown was already dead on the save (the mod reports every set flag, every poll).
  kills         jsonb not null default '{}'::jsonb
);

alter table public.autofire_tests enable row level security;

-- Read your own, for the page's live board. Writes go through start/stop below and the edge
-- function's own database connection, never straight from a browser.
drop policy if exists "autofire_tests select own" on public.autofire_tests;
create policy "autofire_tests select own" on public.autofire_tests
  for select using (user_id = auth.uid());

-- Starts (or restarts) the caller's test from a clean slate. Returns the row's started_at.
create or replace function public.start_autofire_test()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  started timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Sign in to test auto-marking';
  end if;
  if not exists (select 1 from public.ingest_tokens where user_id = auth.uid()) then
    raise exception 'Get your token first';
  end if;

  insert into public.autofire_tests (user_id, started_at, last_seen_at, kills)
  values (auth.uid(), now(), null, '{}'::jsonb)
  on conflict (user_id) do update
    set started_at = excluded.started_at, last_seen_at = null, kills = '{}'::jsonb
  returning started_at into started;
  return started;
end;
$$;

create or replace function public.stop_autofire_test()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.autofire_tests where user_id = auth.uid();
$$;

revoke all on function public.start_autofire_test() from public, anon;
revoke all on function public.stop_autofire_test() from public, anon;
grant execute on function public.start_autofire_test() to authenticated;
grant execute on function public.stop_autofire_test() to authenticated;

comment on table public.autofire_tests is
  'One fake two-square auto-marking test per player, answered by the auto-fire edge function when the player is in no live match. Never a match: no rooms, attacks or archive rows.';
