-- One board source per match, instead of one per shot.
--
-- `match_events` carries `room_id`, `board_seed` and `board_perm` on every row, and all three are
-- facts about the MATCH, not about the shot. Every consumer already reads them that way - see
-- bossFrequency in lib/almanac and archivedBoardSource in lib/matchArchive, both of which do
-- `evs.find(e => e.board_perm)` and use the first one they get. The other hundred-odd copies are
-- read by nothing.
--
-- That redundancy is the single largest thing this site sends. Measured against the archive as it
-- stood the day this landed - 17,853 events across 149 matches, ~120 rows per match:
--
--   whole rows, as the Almanac fetched them        76.8 KB gzip per 1000 rows  ->  1,371 KB
--   the same rows without id/room_id/seed/perm     33.5 KB gzip per 1000 rows  ->    599 KB
--   every match's board source, from this view                                 ->      2.5 KB
--
-- So `board_perm` and its two companions were ~660 KB of every Almanac, Leaderboard and PlayerStats
-- load, to deliver 149 distinct values. 12,006 of those rows carry a perm; sampled by match, every
-- row within a match carries an IDENTICAL one, which is what makes collapsing them safe.
--
-- -- Why a view and not a table --------------------------------------------------------------------
--
-- A `match_board_sources` table was the obvious shape and is the wrong one. It would need a data
-- migration, a new write in archive_match(), and a second place for the board source to be wrong -
-- and it would let the two disagree, which is the one failure mode that breaks historical replay.
-- A view cannot drift from the rows it is derived from. Nothing is copied, nothing is deleted, and
-- `match_events` keeps every column it has: a client that has not been redeployed still reads the
-- perm off the event rows and still works.
--
-- -- Why first-non-null rather than DISTINCT ON -----------------------------------------------------
--
-- DISTINCT ON picks one ROW and takes all three columns off it. The client picks each column
-- independently - three separate `.find()` calls - so a match whose seed and perm happened to land
-- on different rows would lose one. Aggregating per column reproduces the client's semantics
-- exactly. array_agg + FILTER rather than max() because it is defined for every type here
-- (board_perm is jsonb, room_id is uuid) and because "the first one that isn't null" is the rule
-- being copied, not "the largest".
create or replace view public.match_board_sources
with (security_invoker = true) as
select
  e.match_key,
  (array_agg(e.room_id)    filter (where e.room_id    is not null))[1] as room_id,
  (array_agg(e.board_seed) filter (where e.board_seed is not null))[1] as board_seed,
  (array_agg(e.board_perm) filter (where e.board_perm is not null))[1] as board_perm,
  (array_agg(e.square_set) filter (where e.square_set is not null))[1] as square_set,
  max(e.board_size) as board_size
from public.match_events e
group by e.match_key;

comment on view public.match_board_sources is
  'One row per archived match: the room, seed and balancer permutation its squares were dealt from. Derived from match_events, which stores all three on every event row. Read by the Almanac so the bulk event fetch does not have to carry ~120 copies of each.';

-- security_invoker above means this runs as the caller, so match_events' own "match_events select
-- using (true)" policy is what governs it - the same world-readable archive, reached a cheaper way,
-- with no policy of its own to keep in step.
--
-- The grants are still required. This project does not set auto_expose_new_tables, so a new view is
-- unreachable through the Data API until it is granted explicitly; without these the Almanac would
-- get a 404 and silently fall back to naming every match after its size.
grant select on public.match_board_sources to anon, authenticated;
