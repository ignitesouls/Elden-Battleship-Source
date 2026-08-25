-- Shaker's Protégé takes a crew back off four people who never needed one.
--
-- The title is #1 on the honors list and the rarest thing a match can hand out: every hull in an
-- enemy fleet, every killing blow yours, nobody on your own side closing one out. That last clause
-- is the whole difficulty of it - and in a duel it is not a clause at all. There is nobody else on
-- your side, so it cannot be taken from you, and beating the other fleet at all wins the rarest
-- title in the game.
--
-- Every one of the four times it has ever been awarded was a crew of one:
--
--   WILDGALLEON       Mixed      2026-08-13   crew of 1
--   SHATTEREDKEEL     Mixed      2026-08-18   crew of 1
--   WINDSWEPTNARWHAL  jayce_t_t  2026-08-24   crew of 1
--   SALTYLANTERN      jayce_t_t  2026-08-24   crew of 1
--
-- and the last of those is the one that made the rule obvious, because it was won by a fleet that
-- was never on the board. A bug had wiped it mid-battle (see 20260825000000), so its owner could
-- not be hit, could not be sunk, could not lose - and the recap read that as the finest shooting
-- anybody has ever done. lib/matchReport now refuses the title below a crew of three, which is the
-- same line the rest of the app draws between a small room and a full one (bossSetForRoster switches
-- a room off the 2v2 cut of the boss board at exactly three).
--
-- -- What this does and does not rewrite ----------------------------------------------------------
--
-- It removes the title. It does not award a replacement, and that is a deliberate limit rather than
-- an oversight. Shaker's Protégé is `guaranteed`, which takes its holder out of the draw for
-- everything else - so these four hold no other honor in these matches, and under the new rule the
-- engine would have offered them something from the shooting titles instead. Working out WHICH would
-- mean re-deriving each match's whole honors draw from the archive, and the draw is per match: giving
-- one of them a replacement moves every other title in that recap too, and rewrites honors that were
-- correctly earned by people who did nothing wrong. A gap is honest. Inventing four titles and
-- disturbing a dozen more to hide it is not.
--
-- Three places carry an award and all three are corrected, because the recap page reads the stored
-- text rather than re-rendering it, and a leaderboard that disagrees with the recap printed under it
-- is worse than either being wrong alone.
--
-- Match NAMES are not touched and do not need to be: they are derived on read, and lib/matchName's
-- "The Lone Gun" keys off this title, so those matches simply take their next earned name from now
-- on. Nothing stored says otherwise.

-- Everyone holding the title in a crew too small to have earned it. Captured up front, because the
-- first update below is what makes them stop being findable.
create temp table shaker_strip on commit drop as
select p.id as participant_id,
       p.match_key,
       p.nickname
  from match_participants p
  join (
    select match_key, team, count(*) as crew
      from match_participants
     group by match_key, team
  ) c
    on c.match_key = p.match_key
   and c.team = p.team
 where c.crew < 3
   and exists (
     select 1
       from jsonb_array_elements_text(p.awards) as t(value)
      where t.value = 'Shaker''s Protégé'
   );

-- 1. The career record, which is what every leaderboard and the record book's "Rarest honor" read.
update match_participants p
   set awards = (
         select coalesce(jsonb_agg(a.value), '[]'::jsonb)
           from jsonb_array_elements(p.awards) as a(value)
          where a.value <> to_jsonb('Shaker''s Protégé'::text)
       )
  from shaker_strip s
 where s.participant_id = p.id;

-- 2. The recap's own copy, which the archived match page renders as honors.
--
-- One title per match by construction (no title is handed out twice, and its holder can hold no
-- other), so dropping every entry with this title drops exactly the one entry these matches have.
update match_reports r
   set summary = jsonb_set(
         r.summary,
         '{awards}',
         (
           select coalesce(jsonb_agg(a.value), '[]'::jsonb)
             from jsonb_array_elements(r.summary -> 'awards') as a(value)
            where a.value ->> 'title' is distinct from 'Shaker''s Protégé'
         )
       )
 where r.match_key in (select match_key from shaker_strip)
   and jsonb_typeof(r.summary -> 'awards') = 'array';

-- 3. The plain-text recap, printed verbatim on the archived match page and copied from the front
-- page's "Recent battles".
--
-- One honor per line - `${emoji} ${title}: ${nickname} (${detail})` in formatReportText - so the
-- line comes out whole, along with the newline that introduced it. The blank line above the honors
-- block belongs to the block rather than to this title, so it stays.
update match_reports r
   set report_text = regexp_replace(r.report_text, '\n[^\n]*Shaker''s Protégé: [^\n]*', '', 'g')
 where r.match_key in (select match_key from shaker_strip)
   and r.report_text like '%Shaker''s Protégé: %';
