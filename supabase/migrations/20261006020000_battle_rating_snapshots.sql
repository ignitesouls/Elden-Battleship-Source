-- Battle ratings, worked out once per archive change instead of once per recap view.
--
-- A recap's scoreboard shows each captain's battle rating, and a rating is a rank against every game
-- on the board, so it cannot be worked out from the match alone. The recap used to download the whole
-- shot log to do it - about forty requests a page, every player, every match - which was the largest
-- single source of API-gateway log lines on the project, and the one growing with every match played.
--
-- The battle-ratings Edge Function now rates every board and stores the result here. A recap asks the
-- function for its match and gets a stored answer back in one request. The ratings still move as the
-- archive grows, exactly as before: each row carries a fingerprint of the archive (and of the rating
-- code) it was computed from, and the function recomputes whenever that no longer matches - a new
-- match, a void, an admin's shot edit, or a deploy that changed the formula.
--
-- One row per Almanac tab (displaySquareSet), so a recap reads only its own tab's weights and pulls its
-- own match out of `ratings` server-side with `ratings -> match_key`.

create table if not exists public.battle_rating_snapshots (
  square_set text primary key,
  -- md5 of the archive's row counts, sums and voids plus RATING_CODE_VERSION - see the function.
  fingerprint text not null,
  -- Square name -> weight, for the scoreboard's per-square breakdown.
  weights jsonb not null,
  -- match_key -> BattleRating[] for that match's rated captains.
  ratings jsonb not null,
  computed_at timestamptz not null default now()
);

comment on table public.battle_rating_snapshots is
  'Stored battle ratings per Almanac tab, written and read only by the battle-ratings Edge Function. Safe to empty: the next recap view rebuilds it.';

-- Nobody reads or writes this over the API. The function connects to the database directly, as the
-- owner, so RLS with no policies plus revoked grants leaves it reachable by that function alone.
alter table public.battle_rating_snapshots enable row level security;
revoke all on public.battle_rating_snapshots from anon, authenticated;
