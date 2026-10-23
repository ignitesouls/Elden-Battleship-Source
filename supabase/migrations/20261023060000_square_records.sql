-- The world record on every square, stored beside the battle ratings it is worked out with.
--
-- The caster desk's talking points call a record the moment it falls ("0:12 off the world record",
-- "new world record on Malenia"), which needs every square's fastest fight on the board. That is a
-- scan of the whole shot log, the biggest read on the site, so the desk does not do it. The
-- battle-ratings Edge Function already reads that log every time the archive changes, and now also
-- writes each tab's records here (see squareRecords in src/lib/battleRatingBoards.ts). The desk asks
-- for them with one request, { records: <set> }.
--
-- Square name -> { holders, top, median, fights }: up to three record holders fastest first (one place
-- per player), the ten fastest fights by anybody in seconds, the median fight, and how many were timed.
--
-- Defaulted so the function's old insert, which does not name the column, keeps working until the new
-- one is deployed. Apply this BEFORE deploying the function: the new insert names the column and
-- would fail every recompute without it.
alter table public.battle_rating_snapshots
  add column if not exists records jsonb not null default '{}'::jsonb;
