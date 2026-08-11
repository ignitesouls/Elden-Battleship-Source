-- ===========================================================================
--  STRIKE ONE PLAYER FROM ONE MATCH
--  Leaves the match itself standing for everybody else who played it.
-- ===========================================================================
--
-- ⚠ NOT REVERSIBLE. There is no soft-delete on these tables and no restore on
--   the free tier. Take a backup first - the Admin panel on the Leaderboard has
--   a "Download backup (JSON)" button that covers all four tables.
--
-- You usually do NOT need this file. The Admin panel now does the same thing
-- with a button: Leaderboard > Admin > Archived matches > "Crew" > "Remove".
-- This is here for the cases the panel can't reach - a match whose parent
-- report row is gone, a nickname with an awkward character in it, or a bulk
-- pass over several matches at once.
--
-- Three tables carry a per-player trace and all three have to be dealt with,
-- or the site ends up disagreeing with itself about who was there:
--
--   match_participants     the career row - wins, shots, accuracy. THE LEADERBOARD.
--   match_events           their individual shots. The Almanac's heatmaps and timings.
--   match_reports.summary  the recap's scoreboard and honors. Edited, not deleted,
--                          so the match page still renders for everyone else.


-- -- 1. LOOK FIRST ----------------------------------------------------------
-- Find the match, and confirm the exact spelling of the nickname. The nickname
-- is the join key here, so 'kc' and 'KC' are different people as far as these
-- statements are concerned.

select room_code, winner_team, duration, total_shots, finished_at, match_key
  from match_reports
 order by finished_at desc
 limit 10;

select match_key, nickname, team, shots, hits, sunk, won, draw, user_id
  from match_participants
 where match_key = 'PASTE_MATCH_KEY_HERE'
 order by team, nickname;


-- -- 2. THE STRIKE ----------------------------------------------------------
-- Set both values once, at the top, then run the whole block.

begin;

create temp table _strike on commit drop as
select 'PASTE_MATCH_KEY_HERE'::text as match_key,
       'PASTE_NICKNAME_HERE'::text  as nickname;

delete from match_participants p
 using _strike s
 where p.match_key = s.match_key
   and p.nickname  = s.nickname;

delete from match_events e
 using _strike s
 where e.match_key = s.match_key
   and e.nickname  = s.nickname;

-- Rewrites the recap in place: same JSON, minus their scoreboard row and any
-- honors in their name. coalesce covers the case where they were the only entry
-- and jsonb_agg would otherwise return null.
update match_reports r
   set summary = jsonb_set(
         jsonb_set(
           r.summary,
           '{stats}',
           coalesce(
             (select jsonb_agg(x)
                from jsonb_array_elements(r.summary -> 'stats') x
               where x ->> 'nickname' is distinct from s.nickname),
             '[]'::jsonb
           )
         ),
         '{awards}',
         coalesce(
           (select jsonb_agg(x)
              from jsonb_array_elements(r.summary -> 'awards') x
             where x ->> 'nickname' is distinct from s.nickname),
           '[]'::jsonb
         )
       )
  from _strike s
 where r.match_key = s.match_key
   and r.summary ? 'stats';

commit;


-- -- 3. CONFIRM -------------------------------------------------------------
-- Both should come back empty.

select 'participants' as source, nickname, team from match_participants
 where match_key = 'PASTE_MATCH_KEY_HERE' and nickname = 'PASTE_NICKNAME_HERE'
union all
select 'events', nickname, team from match_events
 where match_key = 'PASTE_MATCH_KEY_HERE' and nickname = 'PASTE_NICKNAME_HERE';

-- And the match should still hold everyone else:
select nickname, team, shots, won from match_participants
 where match_key = 'PASTE_MATCH_KEY_HERE'
 order by team, nickname;


-- ===========================================================================
--  VARIANTS
-- ===========================================================================

-- -- A. Every match a player has ever been in -------------------------------
-- Wipes their whole career rather than one game. The leaderboard forgets them
-- entirely; everyone else's matches are untouched.
--
-- delete from match_events       where nickname = 'PASTE_NICKNAME_HERE';
-- delete from match_participants where nickname = 'PASTE_NICKNAME_HERE';

-- -- B. By account rather than by name --------------------------------------
-- Safer when the same nickname has been used by more than one person: this
-- keys on the Twitch account instead. Find the id in the query at the top.
--
-- delete from match_events       where match_key = 'PASTE_MATCH_KEY_HERE' and user_id = 'PASTE_UUID_HERE';
-- delete from match_participants where match_key = 'PASTE_MATCH_KEY_HERE' and user_id = 'PASTE_UUID_HERE';
