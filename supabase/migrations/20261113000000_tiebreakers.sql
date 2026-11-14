-- Tiebreakers that never fall back on original seed.
--
-- A Swiss or group table used to be ordered: wins, game difference, Buchholz, head-to-head (pairs only),
-- then ORIGINAL SEED. In a finished round-robin group Buchholz cannot separate two teams with the same
-- wins, so a three-way tie in a group was, in practice, settled by seed. The new order (see
-- src/lib/tournament/standings.ts, which is where it is applied) is:
--
--   wins -> mini-table among the tied teams -> game difference -> Buchholz (Swiss only)
--        -> most sinks per game -> fewest shots per game -> fastest winning game
--        -> a TIEBREAKER MATCH, played, where the tie decides who advances or how they are seeded.
--
-- The three game stats come from the games actually played (a forfeit or an administrator's result has
-- none, and is left out). That needs two things this migration adds:
--
--   1. Which fleet was which team. A recap stores fleet numbers; the room knew that fleet 1 was team A,
--      but the room forgets it the moment the series is decided and is deleted three days later. So the
--      recap now keeps it (official_team_a / official_team_b), stamped as it is written. Recaps already
--      on file are filled in from the rosters - a fleet whose players are all on one team's roster is
--      that team's.
--   2. tournament_game_stats(event): per bracket match and team, the games played, sinks, shots, and
--      the games won with their total length. The engine aggregates them over whichever matches a table
--      is built from, so a group's table only ever sees that group's games.
--
-- And a new stage, 'tiebreak', for the matches that settle what the numbers cannot. They are drawn by
-- an administrator from the desk (add_tournament_matches, below), linked and played like any official
-- match, and hold the knockout back until they are decided.

-- ===========================================================================
--  1. Which fleet was which team, on the recap itself
-- ===========================================================================
alter table public.match_reports
  add column if not exists official_team_a int,
  add column if not exists official_team_b int;

comment on column public.match_reports.official_team_a is
  'For an official game: the fleet number that played as the bracket match''s team A. Stamped from the room by match_report_official; backfilled from rosters for games filed before it existed.';
comment on column public.match_reports.official_team_b is
  'For an official game: the fleet number that played as the bracket match''s team B.';

-- Reproduced in full from 20260922010000_official_matches; the only change is the two seats copied
-- across from the room.
create or replace function public.match_report_official()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r rooms%rowtype;
begin
  select * into r from rooms where code = new.room_code;
  if found and r.tournament_match_id is not null and not coalesce(new.practice, false) and not coalesce(new.voided, false) then
    new.official := true;
    new.tournament_match_id := r.tournament_match_id;
    new.official_team_a := r.official_team_a;
    new.official_team_b := r.official_team_b;
  end if;
  return new;
end;
$$;

-- Every official game already filed. A seat is filled only when exactly one fleet holds players from
-- that team's roster, and the two seats differ - anything murkier is left empty and simply has no stats.
with seats as (
  select
    r.match_key,
    (select case when count(distinct p.team) = 1 then min(p.team) end
       from match_participants p
       join tournament_roster ro on ro.user_id = p.user_id and ro.entrant_id = m.entrant_a
      where p.match_key = r.match_key) as team_a,
    (select case when count(distinct p.team) = 1 then min(p.team) end
       from match_participants p
       join tournament_roster ro on ro.user_id = p.user_id and ro.entrant_id = m.entrant_b
      where p.match_key = r.match_key) as team_b
  from match_reports r
  join tournament_matches m on m.id = r.tournament_match_id
  where r.official and r.official_team_a is null
)
update match_reports r
   set official_team_a = s.team_a, official_team_b = s.team_b
  from seats s
 where r.match_key = s.match_key
   and s.team_a is not null and s.team_b is not null and s.team_a <> s.team_b;

-- ===========================================================================
--  2. Per-team game stats for an event's matches
-- ===========================================================================
-- One row per bracket match and team that played at least one recorded game in it. `won_seconds` is the
-- recap's own match time (pause-corrected, the clock the recap prints) summed over the games that team
-- won; `won_games` counts only won games whose time is known, so the average is always over real times.
-- Voided and practice games are left out, exactly as they are from the series score.
create or replace function public.tournament_game_stats(p_tournament uuid)
returns table (match_key text, entrant_id uuid, games int, sinks int, shots int, won_games int, won_seconds int)
language sql
stable
security definer
set search_path = public
as $$
  with played as (
    select m.key, r.match_key as game, r.winner_team,
           case
             when r.duration ~ '^[0-9]+:[0-9]{2}:[0-9]{2}$'
               then split_part(r.duration, ':', 1)::int * 3600 + split_part(r.duration, ':', 2)::int * 60 + split_part(r.duration, ':', 3)::int
             when r.duration ~ '^[0-9]+:[0-9]{2}$'
               then split_part(r.duration, ':', 1)::int * 60 + split_part(r.duration, ':', 2)::int
           end as secs,
           seat.entrant, seat.team
      from tournament_matches m
      join match_reports r on r.tournament_match_id = m.id
      cross join lateral (values (m.entrant_a, r.official_team_a), (m.entrant_b, r.official_team_b)) as seat(entrant, team)
     where m.tournament_id = p_tournament
       and public.tournament_visible(p_tournament)
       and r.official and not r.voided and not coalesce(r.practice, false)
       and not exists (select 1 from voided_matches v where v.match_key = r.match_key)
       and seat.entrant is not null and seat.team is not null
  ),
  per_game as (
    select pl.key, pl.entrant, pl.game,
           pl.team = pl.winner_team as won,
           pl.secs,
           coalesce((select sum(p.sunk)  from match_participants p where p.match_key = pl.game and p.team = pl.team), 0) as game_sinks,
           coalesce((select sum(p.shots) from match_participants p where p.match_key = pl.game and p.team = pl.team), 0) as game_shots
      from played pl
  )
  -- Column names differ from the output names on purpose: in a SQL function an output name and a
  -- column name that match are easy to misread, even though the column wins.
  select pg.key, pg.entrant, count(*)::int, sum(pg.game_sinks)::int, sum(pg.game_shots)::int,
         (count(*) filter (where pg.won and pg.secs is not null))::int,
         coalesce(sum(pg.secs) filter (where pg.won and pg.secs is not null), 0)::int
    from per_game pg
   group by pg.key, pg.entrant;
$$;

grant execute on function public.tournament_game_stats(uuid) to anon, authenticated;

-- ===========================================================================
--  3. The tiebreak stage
-- ===========================================================================
alter table public.tournament_matches drop constraint if exists tournament_matches_stage_check;
alter table public.tournament_matches
  add constraint tournament_matches_stage_check check (stage in ('swiss', 'group', 'knockout', 'tiebreak'));

-- Reproduced in full from 20260922000000_tournament_running. Changes: a 'tiebreak' draw is accepted once
-- the qualifier's own matches are all decided and before the knockout exists, and the knockout now also
-- waits for every tiebreak match.
create or replace function public.add_tournament_matches(p_tournament uuid, p_stage text, p_matches jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  t tournaments%rowtype;
  q_format text;
  q_rounds int;
  has_knockout boolean;
  current_round int;
  round_drawn int;
  entrants uuid[];
  inserted int;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can draw matches';
  end if;

  select * into t from tournaments where id = p_tournament for update;
  if not found then
    raise exception 'There is no such event';
  end if;
  if t.status <> 'live' then
    raise exception 'Matches can only be drawn for a running event (this one is %)', t.status;
  end if;
  if p_stage not in ('swiss', 'knockout', 'tiebreak') then
    raise exception 'Only a Swiss round, a tiebreaker or a knockout can be drawn after the start';
  end if;
  if jsonb_typeof(p_matches) is distinct from 'array' or jsonb_array_length(p_matches) = 0 then
    raise exception 'There are no matches to draw';
  end if;
  if exists (select 1 from jsonb_array_elements(p_matches) m where (m ->> 'stage') is distinct from p_stage) then
    raise exception 'Every match must belong to the % stage', p_stage;
  end if;

  q_format := t.format -> 'qualifier' ->> 'format';
  q_rounds := coalesce((t.format -> 'qualifier' ->> 'rounds')::int, 0);
  has_knockout := coalesce(jsonb_typeof(t.format -> 'knockout') = 'object', false);

  if p_stage = 'swiss' then
    if q_format is distinct from 'swiss' then
      raise exception 'This event has no Swiss rounds';
    end if;
    select coalesce(max(m.round), 0) into current_round from tournament_matches m
     where m.tournament_id = p_tournament and m.stage = 'swiss';
    if exists (
      select 1 from tournament_matches m
       where m.tournament_id = p_tournament and m.stage = 'swiss' and m.status in ('pending', 'ready', 'in_progress')
    ) then
      raise exception 'Round % is not finished - every match has to be decided before the next round is drawn', current_round;
    end if;
    if current_round >= q_rounds then
      raise exception 'All % Swiss rounds have already been drawn', q_rounds;
    end if;
    select count(distinct (m ->> 'round')::int), min((m ->> 'round')::int) into inserted, round_drawn
      from jsonb_array_elements(p_matches) m;
    if inserted <> 1 or round_drawn <> current_round + 1 then
      raise exception 'The next Swiss round is round %', current_round + 1;
    end if;
  elsif p_stage = 'tiebreak' then
    if q_format is null or q_format not in ('swiss', 'groups') then
      raise exception 'Only a Swiss or group qualifier has standings to break a tie in';
    end if;
    if exists (select 1 from tournament_matches m where m.tournament_id = p_tournament and m.stage = 'knockout') then
      raise exception 'The knockout has already been built';
    end if;
    if q_format = 'swiss' then
      select coalesce(max(m.round), 0) into current_round from tournament_matches m
       where m.tournament_id = p_tournament and m.stage = 'swiss';
      if current_round < q_rounds then
        raise exception 'The Swiss rounds are not all played yet (% of % drawn)', current_round, q_rounds;
      end if;
    end if;
    if exists (
      select 1 from tournament_matches m
       where m.tournament_id = p_tournament and m.stage in ('swiss', 'group', 'tiebreak') and m.status in ('pending', 'ready', 'in_progress')
    ) then
      raise exception 'A tiebreaker can only be drawn once every qualifier and tiebreaker match is decided';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_matches) m
       where (m ->> 'entrant_a') is null or (m ->> 'entrant_b') is null or coalesce((m ->> 'is_bye')::boolean, false)
    ) then
      raise exception 'A tiebreaker match needs two teams';
    end if;
  else
    if not has_knockout then
      raise exception 'This event has no knockout';
    end if;
    if exists (select 1 from tournament_matches m where m.tournament_id = p_tournament and m.stage = 'knockout') then
      raise exception 'The knockout has already been built';
    end if;
    if q_format = 'swiss' then
      select coalesce(max(m.round), 0) into current_round from tournament_matches m
       where m.tournament_id = p_tournament and m.stage = 'swiss';
      if current_round < q_rounds then
        raise exception 'The Swiss rounds are not all played yet (% of % drawn)', current_round, q_rounds;
      end if;
    end if;
    if q_format in ('swiss', 'groups') and exists (
      select 1 from tournament_matches m
       where m.tournament_id = p_tournament and m.stage in ('swiss', 'group', 'tiebreak') and m.status in ('pending', 'ready', 'in_progress')
    ) then
      raise exception 'The qualifier is not finished - every match (tiebreakers included) has to be decided before the knockout is built';
    end if;
  end if;

  -- Only teams that are in this event may be drawn.
  select coalesce(array_agg(e.id), '{}') into entrants from tournament_entrants e
   where e.tournament_id = p_tournament and e.status = 'approved';
  if exists (
    select 1
      from jsonb_array_elements(p_matches) m
     where ((m ->> 'entrant_a') is not null and not ((m ->> 'entrant_a')::uuid = any(entrants)))
        or ((m ->> 'entrant_b') is not null and not ((m ->> 'entrant_b')::uuid = any(entrants)))
        or ((m ->> 'winner') is not null and not ((m ->> 'winner')::uuid = any(entrants)))
  ) then
    raise exception 'A match names a team that is not in this event';
  end if;

  insert into tournament_matches (
    tournament_id, key, stage, bracket, grp, round, idx, phase, entrant_a, entrant_b, best_of,
    score_a, score_b, status, winner, winner_to_key, winner_to_side, loser_to_key, loser_to_side,
    reset_of, is_bye, opens_at, due_at, result_kind
  )
  select p_tournament, m.key, m.stage, m.bracket, m.grp, m.round, m.idx, m.phase, m.entrant_a, m.entrant_b,
         coalesce(m.best_of, 1), coalesce(m.score_a, 0), coalesce(m.score_b, 0), coalesce(m.status, 'pending'),
         m.winner, m.winner_to_key, m.winner_to_side, m.loser_to_key, m.loser_to_side,
         m.reset_of, coalesce(m.is_bye, false), m.opens_at, m.due_at, coalesce(m.result_kind, 'played')
    from jsonb_to_recordset(p_matches) as m(
      key text, stage text, bracket text, grp int, round int, idx int, phase int,
      entrant_a uuid, entrant_b uuid, best_of int, score_a int, score_b int, status text, winner uuid,
      winner_to_key text, winner_to_side text, loser_to_key text, loser_to_side text,
      reset_of text, is_bye boolean, opens_at timestamptz, due_at timestamptz, result_kind text
    );
  get diagnostics inserted = row_count;

  -- A team an administrator has already removed must not be left holding up the new matches.
  perform public.tournament_settle_forfeits(p_tournament);

  return inserted;
end;
$$;

grant execute on function public.add_tournament_matches(uuid, text, jsonb) to authenticated;

-- Reproduced in full from 20260921040000_tournament_auto_finish. The only change: an event with no
-- knockout is not complete while a tiebreak match is still open.
create or replace function public.tournament_is_complete(p_tournament uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  f jsonb;
  has_knockout boolean;
  qualifier text;
  rounds_needed int;
  drawn int;
begin
  select t.format into f from tournaments t where t.id = p_tournament;
  if f is null then
    return false;
  end if;

  has_knockout := coalesce(jsonb_typeof(f -> 'knockout') = 'object', false);
  qualifier := f -> 'qualifier' ->> 'format';

  if has_knockout then
    -- The knockout has to exist (it is built after the qualifier) and have nothing left open. A
    -- skipped grand-final reset is not open; an undecided one is.
    return exists (select 1 from tournament_matches m where m.tournament_id = p_tournament and m.stage = 'knockout')
       and not exists (
         select 1 from tournament_matches m
          where m.tournament_id = p_tournament and m.stage = 'knockout'
            and m.status in ('pending', 'ready', 'in_progress')
       );
  end if;

  if qualifier = 'swiss' then
    rounds_needed := coalesce((f -> 'qualifier' ->> 'rounds')::int, 0);
    select coalesce(max(m.round), 0) into drawn from tournament_matches m
     where m.tournament_id = p_tournament and m.stage = 'swiss';
    return rounds_needed > 0 and drawn >= rounds_needed
       and not exists (
         select 1 from tournament_matches m
          where m.tournament_id = p_tournament and m.stage in ('swiss', 'tiebreak')
            and m.status in ('pending', 'ready', 'in_progress')
       );
  end if;

  if qualifier = 'groups' then
    return exists (select 1 from tournament_matches m where m.tournament_id = p_tournament and m.stage = 'group')
       and not exists (
         select 1 from tournament_matches m
          where m.tournament_id = p_tournament and m.stage in ('group', 'tiebreak')
            and m.status in ('pending', 'ready', 'in_progress')
       );
  end if;

  return false;
end;
$$;
