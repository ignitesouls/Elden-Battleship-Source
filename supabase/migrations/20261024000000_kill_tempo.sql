-- How soon into a match captains reach 5, 10, 15 and 20 kills, stored beside the square records.
--
-- The caster desk's talking points now say how EARLY things happen as well as how fast each fight was:
-- "the fastest start to 10 kills anyone has ever had", "most captains are there around 52:00". Like the
-- square records (20261023060000) that is a scan of the whole shot log, so the battle-ratings Edge
-- Function works it out whenever the archive changes and the desk reads it in the same one request,
-- { records: <set> } -> { records, tempo }. See killTempo in src/lib/battleRatingBoards.ts.
--
-- Kill count (as text) -> { earliest, median, runs }: who reached it soonest and when, the middle time it
-- is reached at, and in how many matches a captain reached it.
--
-- The new fields on each square record (`at`, when it falls) need no column - they ride inside `records`.
--
-- Defaulted so the function's current insert, which does not name the column, keeps working until the
-- new one is deployed. Apply this BEFORE deploying the function: the new insert names the column and
-- would fail every recompute without it.
alter table public.battle_rating_snapshots
  add column if not exists tempo jsonb not null default '{}'::jsonb;
