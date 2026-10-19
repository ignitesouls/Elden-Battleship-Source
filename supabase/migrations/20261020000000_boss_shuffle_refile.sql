-- Re-files the four matches played on the boss randomizer under the new Boss Shuffle set.
--
-- They were played in ordinary boss rooms, before Boss Shuffle existed, so every row says 'bosses'
-- and their kill times sit in the boss board's records - where they do not belong, because on the
-- randomizer every boss is standing somewhere else. Moving them is a relabel and nothing more: Boss
-- Shuffle deals exactly as the boss board does (squareSets.dealsAs), so every board rebuilt from
-- these rows - the Almanac's census, the recap, the overlays - comes out identical to the one played.
--
-- Listed by exact match key rather than by room code or date: a room code is reused across rooms and
-- days, and this must touch these four games and nothing else.
--
--   RUSTYTRIDENT   2026-10-12
--   FADEDSEXTANT   2026-10-13
--   SUNKENCOMPASS  2026-10-14
--   RUSTYLEVIATHAN 2026-10-16
--
-- The ratings snapshot is cleared at the end. Its fingerprint is built from row counts and sums, and
-- a relabel changes none of them, so without this the Hall of Fame would keep rating these games as
-- boss-board games until something else happened to change the archive.

do $$
declare
  v_keys text[] := array[
    'RUSTYTRIDENT:2026-10-12 13:21:39.107907+00',
    'FADEDSEXTANT:2026-10-13 18:19:27.819947+00',
    'SUNKENCOMPASS:2026-10-14 17:53:58.978772+00',
    'RUSTYLEVIATHAN:2026-10-16 19:33:23.696065+00'
  ];
  v_found int;
begin
  select count(*) into v_found from match_reports where match_key = any(v_keys);
  -- Recaps are swept after 30 days but the stats rows stay (see report sweep), so a missing report
  -- is not an error by itself - only a key that is missing everywhere is.
  if v_found < 4 and (select count(distinct match_key) from match_participants where match_key = any(v_keys)) < 4 then
    raise exception 'Boss Shuffle refile: expected 4 matches, found % reports', v_found;
  end if;

  update match_reports      set square_set = 'boss-shuffle' where match_key = any(v_keys);
  update match_participants set square_set = 'boss-shuffle' where match_key = any(v_keys);
  update match_events       set square_set = 'boss-shuffle' where match_key = any(v_keys);
  update match_fleets       set square_set = 'boss-shuffle' where match_key = any(v_keys);

  delete from battle_rating_snapshots where true;
end $$;
