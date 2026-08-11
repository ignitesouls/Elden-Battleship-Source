-- ===========================================================================
--  RENAME THREE HONOR TITLES IN THE ARCHIVE
--  Old Grudge           -> The Old Man and the Sea
--  Sounding Empty Water -> Water, Water, Everywhere
--  Ship's Navigator     -> Das Boot
-- ===========================================================================
--
-- Run this ONCE, after the code carrying the new titles is deployed. Honors are
-- recomputed from the attack log every time a recap renders, so new matches
-- already write the new spelling - this is only about the matches already in the
-- archive.
--
-- Why it matters: an honor title is a string key, not just display text.
-- lib/careerStats.ts tallies a player's career awards by exact title, so without
-- this a profile shows "Old Grudge x2" and "The Old Man and the Sea x1" as two
-- unrelated achievements.
--
-- ⚠ NOT REVERSIBLE. Take a backup first - Leaderboard > Admin has a
--   "Download backup (JSON)" button covering all four tables.
--
-- Two tables carry the title, and both have to be rewritten or the site
-- disagrees with itself about what somebody won:
--
--   match_participants.awards   jsonb array of title STRINGS. The career tally.
--   match_reports.summary       {stats, awards} - awards are full objects
--                               ({title, emoji, nickname, detail}). The recap.
--
-- The emoji did not change for any of the three, so only `title` is touched.


-- -- 1. LOOK FIRST ----------------------------------------------------------
-- How many rows are about to move. Both should be 0 on a second run.

select 'career rows' as source, count(*)
  from match_participants
 where awards ?| array['Old Grudge', 'Sounding Empty Water', 'Ship''s Navigator']
union all
select 'recaps', count(*)
  from match_reports
 where summary -> 'awards' @> '[{"title":"Old Grudge"}]'
    or summary -> 'awards' @> '[{"title":"Sounding Empty Water"}]'
    or summary -> 'awards' @> '[{"title":"Ship''s Navigator"}]';


-- -- 2. REWRITE --------------------------------------------------------------

begin;

-- The career tally. `with ordinality` and the matching `order by` keep the
-- awards in the order they were written; jsonb_agg does not otherwise promise it.
update match_participants
   set awards = coalesce(
         (select jsonb_agg(
                   case x #>> '{}'
                     when 'Old Grudge'           then '"The Old Man and the Sea"'::jsonb
                     when 'Sounding Empty Water' then '"Water, Water, Everywhere"'::jsonb
                     when 'Ship''s Navigator'    then '"Das Boot"'::jsonb
                     else x
                   end
                   order by ord
                 )
            from jsonb_array_elements(awards) with ordinality as t(x, ord)),
         '[]'::jsonb
       )
 where awards ?| array['Old Grudge', 'Sounding Empty Water', 'Ship''s Navigator'];

-- The recap. Same rewrite one level deeper, leaving emoji, nickname and detail
-- alone - the detail lines were written to read under either name.
update match_reports
   set summary = jsonb_set(
         summary,
         '{awards}',
         coalesce(
           (select jsonb_agg(
                     case x ->> 'title'
                       when 'Old Grudge'           then jsonb_set(x, '{title}', '"The Old Man and the Sea"')
                       when 'Sounding Empty Water' then jsonb_set(x, '{title}', '"Water, Water, Everywhere"')
                       when 'Ship''s Navigator'    then jsonb_set(x, '{title}', '"Das Boot"')
                       else x
                     end
                     order by ord
                   )
              from jsonb_array_elements(summary -> 'awards') with ordinality as t(x, ord)),
           '[]'::jsonb
         )
       )
 where summary -> 'awards' @> '[{"title":"Old Grudge"}]'
    or summary -> 'awards' @> '[{"title":"Sounding Empty Water"}]'
    or summary -> 'awards' @> '[{"title":"Ship''s Navigator"}]';

commit;


-- -- 3. CONFIRM --------------------------------------------------------------
-- The first query should come back empty: no old spelling left anywhere.

select 'career rows' as source, match_key, nickname, awards
  from match_participants
 where awards ?| array['Old Grudge', 'Sounding Empty Water', 'Ship''s Navigator'];

-- And the new spelling should be there instead, on the same matches.

select x ->> 'nickname' as nickname, x ->> 'title' as title, x ->> 'detail' as detail
  from match_reports r,
       jsonb_array_elements(r.summary -> 'awards') x
 where x ->> 'title' in ('The Old Man and the Sea', 'Water, Water, Everywhere', 'Das Boot')
 order by r.finished_at desc
 limit 50;
