-- ===========================================================================
--  WIPE THE RECORD BOOKS
--  Clears everything behind the Leaderboard, the Almanac, the player stats
--  pages, and the "Recent battles" list on the home page.
-- ===========================================================================
--
-- ⚠ THIS IS NOT REVERSIBLE. There is no soft-delete and no backup of these
--   tables. Run section 1 first and read what it tells you.
--
-- Why this has to be run by hand in the SQL editor: the four archive tables
-- carry SELECT and INSERT policies only, with no DELETE policy at all. That is
-- deliberate and should stay that way - a DELETE policy reachable from the
-- anon key would let any visitor erase everyone's career records. The SQL
-- editor runs as the table owner and bypasses RLS, which is exactly the right
-- level of friction for an operation like this.
--
-- The four tables have NO foreign keys between them. They are joined on the
-- text column `match_key`, so the delete order below is arbitrary and you can
-- safely run any subset of them.
--
-- Keep this file. You will want it again after the next round of testing.


-- -- 1. LOOK FIRST ----------------------------------------------------------
-- Run this on its own before deleting anything.

select 'match_reports'      as table_name, count(*) as rows from match_reports
union all
select 'match_participants', count(*) from match_participants
union all
select 'match_fleets',       count(*) from match_fleets
union all
select 'match_events',       count(*) from match_events
order by table_name;

-- And the matches themselves, so you can see what you're about to lose:
select room_code, winner_team, duration, total_shots, finished_at
  from match_reports
 order by finished_at desc;


-- -- 2. THE WIPE ------------------------------------------------------------
-- Erases every archived match. Run all four together.

delete from match_events;
delete from match_fleets;
delete from match_participants;
delete from match_reports;


-- -- 3. CONFIRM -------------------------------------------------------------
-- All four should come back 0.

select 'match_reports'      as table_name, count(*) as rows from match_reports
union all
select 'match_participants', count(*) from match_participants
union all
select 'match_fleets',       count(*) from match_fleets
union all
select 'match_events',       count(*) from match_events
order by table_name;


-- ===========================================================================
--  OPTIONAL EXTRAS - each is independent, run only what you want
-- ===========================================================================

-- -- A. Wipe only ONE match rather than all of them -------------------------
-- Useful once real games are on the board and you only want to remove a
-- specific test. Set the room code and run all four.
--
-- delete from match_events       where match_key in (select match_key from match_reports where room_code = 'GRIMSCHOONER');
-- delete from match_fleets       where match_key in (select match_key from match_reports where room_code = 'GRIMSCHOONER');
-- delete from match_participants where match_key in (select match_key from match_reports where room_code = 'GRIMSCHOONER');
-- delete from match_reports      where room_code = 'GRIMSCHOONER';


-- -- B. Wipe everything recorded before a cutoff ----------------------------
-- The shape you want when going live: bin the testing, keep real games.
-- Adjust the timestamp, then run all four.
--
-- delete from match_events       where finished_at < timestamptz '2026-07-27 00:00+00';
-- delete from match_fleets       where finished_at < timestamptz '2026-07-27 00:00+00';
-- delete from match_participants where finished_at < timestamptz '2026-07-27 00:00+00';
-- delete from match_reports      where finished_at < timestamptz '2026-07-27 00:00+00';


-- -- C. Clear leftover test ROOMS -------------------------------------------
-- Rooms are separate from the record books - they hold live game state and are
-- normally removed by prune_stale_rooms(). Nothing can delete them by hand,
-- because there is no DELETE policy on `rooms` either. This clears any that are
-- lingering and cascades to their players, fleets and attacks.
--
-- select code, status, created_at from rooms order by created_at;
-- delete from rooms where code like 'TRIGGERTEST%';   -- leftover from a trigger test
-- select public.prune_stale_rooms();                   -- or just run the normal pruner


-- -- D. Twitch profiles -----------------------------------------------------
-- NOT wiped above, on purpose. A profile row is only a display name and avatar
-- cached at login; it holds no match history, and deleting it just means the
-- next sign-in recreates it. Uncomment if you want a truly blank slate.
--
-- delete from profiles;
