-- A match can be struck from the record books without being erased from them.
--
-- The tools that existed either kept a match whole or destroyed it: "Delete" wipes all four archive
-- tables, and "Crew" strikes one name from a match everybody else keeps. Neither fits a match whose
-- SHOTS were real but whose CLOCK is fiction.
--
-- The case this was built for: RUSTYSQUALL, 15 Aug 2026. Three captains first fired 62 minutes in
-- and entered twenty squares in twenty-five seconds - a backlog held and dumped at once. Every hit
-- and miss in that burst was a real square really taken, so deleting the match would throw away
-- true results; but the gaps between them are not how long anything took, and every timing figure
-- on the site is built from those gaps. It gave one captain a 0:45 "best match" against a 2:52
-- median, which is not a pace, it is an artefact.
--
-- So: voided. The row stays, the recap page still renders, the history list still lists it, and
-- every stat and record reads past it. What that costs is stated plainly - the match's genuine
-- hit/miss results and its W-L line for all six captains go too - and it is the price of one rule
-- that needs no per-stat exceptions to explain.
alter table public.match_reports
  add column if not exists voided boolean not null default false;

comment on column public.match_reports.voided is
  'Struck from every stat and record while staying in the archive. Set by an admin from the Admin panel; read by the client before any stats fetch and by the balance-stats sweep.';

-- Every reader wants the same thing: the short list of keys to skip. A partial index keeps that a
-- lookup over the voided rows rather than a scan of the whole archive, which is what it would
-- otherwise be on a column that is false nearly everywhere.
create index if not exists match_reports_voided_idx
  on public.match_reports (match_key)
  where voided;

-- No new policy. "match_reports update by admin" (20260726110000_admins.sql) already covers every
-- column, and INSERT has been closed to everyone since 20260726120000 - archive_match() is still
-- the only way a report row is born, and it has no reason to know about this flag.

-- -- The match this was built for -----------------------------------------------------------------
update public.match_reports
   set voided = true
 where match_key = 'RUSTYSQUALL:2026-08-15 01:17:56.470891+00';
