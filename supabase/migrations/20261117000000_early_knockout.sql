-- The playoffs can start before the group stage ends.
--
-- Until now the knockout waited for every group match, including games between teams that were long
-- out and could only shuffle the bottom of a table. Now it can be built as soon as who goes through,
-- and where they are seeded, can no longer change:
--
--   1. every team going through has played all its group games. Seeding across groups compares wins,
--      game difference and the per-game stats, and any game a qualified team still had could move them;
--   2. every team still playing is out of reach: winning everything left, it still ends with fewer wins
--      than the weakest qualifier in its group.
--
-- The games left over are played on for final places, alongside the knockout. Mirrors groupSettled() in
-- src/lib/tournament/stages.ts.
--
-- -- When the event ends ------------------------------------------------------------------------------
-- The champion is crowned the moment the knockout is done, but the event stays live, since playing a
-- game (official rooms, scheduling, casts) needs a live event, until the leftovers are decided. A
-- leftover still unplayed after its due date, or 7 days after the final if it has none, is dropped
-- ('skipped': it counts for nobody) by a daily job, and dropping the last one finishes the event. That
-- is the only thing a clock ever decides here, and only for games that cannot change the knockout:
-- deadlines on games that matter stay advisory (see 20260921030000_tournament_schedule).

-- ===========================================================================
--  1. When the champion was crowned
-- ===========================================================================
alter table public.tournaments add column if not exists crowned_at timestamptz;

comment on column public.tournaments.crowned_at is
  'When the knockout was won. Leftover group games with no due date are dropped 7 days after it.';
comment on column public.tournaments.champion_id is
  'The winner of the knockout, recorded as soon as the knockout is done - while leftover group games are still being played, too. Null for an event with no knockout (its table decides).';

-- Events crowned before this column existed were crowned when they finished.
update public.tournaments set crowned_at = finished_at where champion_id is not null and crowned_at is null;

-- ===========================================================================
--  2. Is a group settled?
-- ===========================================================================
-- `p_teams` are the teams going through (from every group: only this group's members are looked at).
-- True when none of them in this group has a group game left, and every team in it that does have one
-- would still finish below the weakest of them on wins, winning everything.
create or replace function public.tournament_group_settled(p_tournament uuid, p_grp int, p_teams uuid[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with gm as (
    select m.entrant_a, m.entrant_b, m.status, m.winner from tournament_matches m
     where m.tournament_id = p_tournament and m.stage = 'group' and m.grp = p_grp
  ), members as (
    select distinct x as id from gm, unnest(array[gm.entrant_a, gm.entrant_b]) as x where x is not null
  ), tally as (
    select mb.id,
           (select count(*) from gm where gm.status = 'done' and gm.winner = mb.id) as wins,
           (select count(*) from gm where gm.status in ('pending', 'ready', 'in_progress') and mb.id in (gm.entrant_a, gm.entrant_b)) as open
      from members mb
  )
  select not exists (select 1 from tally where tally.id = any(p_teams) and tally.open > 0)
     and not exists (
       select 1 from tally o
        where not (o.id = any(p_teams)) and o.open > 0
          and o.wins + o.open >= (select min(q.wins) from tally q where q.id = any(p_teams))
     );
$$;

revoke all on function public.tournament_group_settled(uuid, int, uuid[]) from public, anon, authenticated;

-- ===========================================================================
--  3. Drawing the knockout (and tiebreakers) early
-- ===========================================================================
-- Reproduced in full from 20261113000000_tiebreakers. Changes, for a group qualifier only: the knockout
-- no longer waits for group games that cannot change it (every group with a game open has to be settled
-- for the teams being drawn), and a tiebreaker likewise only waits on the groups of the teams in it.
-- Swiss is unchanged: its next pairings hang on every result.
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
  drawn uuid[];
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
  -- Every team the draw names: for a knockout, the teams going through (round one and its byes).
  select coalesce(array_agg(distinct x), '{}') into drawn
    from jsonb_array_elements(p_matches) m,
         unnest(array[(m ->> 'entrant_a')::uuid, (m ->> 'entrant_b')::uuid]) as x
   where x is not null;

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
       where m.tournament_id = p_tournament and m.stage in ('swiss', 'tiebreak') and m.status in ('pending', 'ready', 'in_progress')
    ) or exists (
      select 1 from (
        select distinct m.grp from tournament_matches m
         where m.tournament_id = p_tournament and m.stage = 'group' and m.status in ('pending', 'ready', 'in_progress')
      ) g
       where not public.tournament_group_settled(p_tournament, g.grp, drawn)
    ) then
      raise exception 'A tiebreaker can only be drawn once every qualifier and tiebreaker match that could still move the tied teams is decided';
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
       where m.tournament_id = p_tournament and m.stage in ('swiss', 'tiebreak') and m.status in ('pending', 'ready', 'in_progress')
    ) then
      raise exception 'The qualifier is not finished - every match (tiebreakers included) has to be decided before the knockout is built';
    end if;
    if q_format = 'groups' and exists (
      select 1 from (
        select distinct m.grp from tournament_matches m
         where m.tournament_id = p_tournament and m.stage = 'group' and m.status in ('pending', 'ready', 'in_progress')
      ) g
       where not public.tournament_group_settled(p_tournament, g.grp, drawn)
    ) then
      raise exception 'The group stage is not settled - a team going through still has a group game to play, or a team still playing could yet catch them';
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

-- ===========================================================================
--  4. Complete, and crowned
-- ===========================================================================
-- Reproduced in full from 20261113000000_tiebreakers. The only change: an event with a knockout is not
-- complete while a leftover qualifier game is still open. Mirrors tournamentComplete() in complete.ts.
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
    -- skipped grand-final reset is not open; an undecided one is. Nor may a leftover group game be
    -- open: it is still being played for final places (or will be dropped at its deadline).
    return public.tournament_knockout_done(p_tournament)
       and not exists (
         select 1 from tournament_matches m
          where m.tournament_id = p_tournament and m.stage <> 'knockout'
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

-- The knockout exists and nothing in it is left to play. Mirrors knockoutDone() in complete.ts.
create or replace function public.tournament_knockout_done(p_tournament uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from tournament_matches m where m.tournament_id = p_tournament and m.stage = 'knockout')
     and not exists (
       select 1 from tournament_matches m
        where m.tournament_id = p_tournament and m.stage = 'knockout'
          and m.status in ('pending', 'ready', 'in_progress')
     );
$$;

revoke all on function public.tournament_knockout_done(uuid) from public, anon, authenticated;

-- Reproduced in full from 20260921040000_tournament_auto_finish. Changes: the champion is crowned (and
-- crowned_at stamped) as soon as the knockout is done, even while the event stays live for leftover
-- games, and uncrowned if a correction reopens the knockout. Mirrors eventChampion() in complete.ts.
create or replace function public.tournament_sync_finished(p_tournament uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t tournaments%rowtype;
  complete boolean;
  champ uuid;
begin
  select * into t from tournaments where id = p_tournament for update;
  if not found then
    return;
  end if;
  -- Only a running event can be finished by its bracket, and only one the bracket finished can be
  -- reopened by it. Drafts, open signups and cancelled events are none of its business, and neither
  -- is an event an administrator finished by hand.
  if t.status not in ('live', 'finished') then
    return;
  end if;
  if t.status = 'finished' and not t.finished_by_bracket then
    return;
  end if;

  complete := public.tournament_is_complete(p_tournament);
  champ := case when coalesce(jsonb_typeof(t.format -> 'knockout') = 'object', false) and public.tournament_knockout_done(p_tournament)
                then public.tournament_champion(p_tournament) end;

  if complete and t.status = 'live' then
    update tournaments set status = 'finished', finished_by_bracket = true where id = p_tournament;
  elsif not complete and t.status = 'finished' then
    -- (The bookkeeping trigger clears the champion on the way out; it is put back just below.)
    update tournaments set status = 'live', finished_by_bracket = false where id = p_tournament;
  end if;

  -- Crowned, recrowned or uncrowned, whether or not the event is still running. Never a status
  -- change, so the bookkeeping trigger leaves finished_by_bracket alone.
  update tournaments
     set champion_id = champ,
         crowned_at = case when champ is null then null else coalesce(crowned_at, now()) end
   where id = p_tournament
     and (champion_id is distinct from champ or (champ is null) <> (crowned_at is null));
end;
$$;

revoke all on function public.tournament_sync_finished(uuid) from public, anon, authenticated;

-- ===========================================================================
--  5. Dropping leftover games once the champion is crowned
-- ===========================================================================
-- Only group games, only in a live event whose knockout is won, and only past their due date (or 7
-- days after the final when they have none). Each one dropped goes through the match trigger, which
-- finishes the event once nothing is left open.
create or replace function public.tournament_drop_dead_games()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  dropped int;
begin
  update tournament_matches m
     set status = 'skipped'
    from tournaments t
   where t.id = m.tournament_id
     and t.status = 'live' and t.champion_id is not null and t.crowned_at is not null
     and m.stage = 'group'
     and m.status in ('pending', 'ready', 'in_progress')
     and coalesce(m.due_at, t.crowned_at + interval '7 days') < now();
  get diagnostics dropped = row_count;
  return dropped;
end;
$$;

revoke all on function public.tournament_drop_dead_games() from public, anon, authenticated;

-- Once a day at 20:00 UTC (04:00 at UTC+8), a quiet hour. It runs inside the database, so it makes no
-- API requests. pg_cron is already enabled (prune-stale-rooms).
create extension if not exists pg_cron;

select cron.unschedule('drop-dead-tournament-games')
where exists (select 1 from cron.job where jobname = 'drop-dead-tournament-games');

select cron.schedule(
  'drop-dead-tournament-games',
  '0 20 * * *',
  $$select public.tournament_drop_dead_games()$$
);
