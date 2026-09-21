-- Running an event: drawing later stages, and handing a team's captaincy on.
--
-- start_tournament draws the FIRST stage. Most formats have more to come: a Swiss event draws one round
-- at a time (who plays whom depends on the results so far), and a qualifier followed by a knockout
-- builds the knockout only once the qualifier is over and its standings say who is through. Both are
-- "add some matches to a running event", which is what add_tournament_matches does - and like starting,
-- it is administrators only, checked inside the function, and all-or-nothing.
--
-- -- Why it insists on the order ---------------------------------------------------------------------
-- Drawing round 3 before round 2 is played would pair people on results that do not exist yet, and
-- building the knockout early would seed it from a table still being written. The engine that draws the
-- matches runs in the administrator's browser, so the database cannot re-derive them - but it can refuse
-- to accept a draw at the wrong time, which is the mistake that matters and the one a stale page makes.

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
  if p_stage not in ('swiss', 'knockout') then
    raise exception 'Only a Swiss round or a knockout can be drawn after the start';
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
       where m.tournament_id = p_tournament and m.stage in ('swiss', 'group') and m.status in ('pending', 'ready', 'in_progress')
    ) then
      raise exception 'The qualifier is not finished - every match has to be decided before the knockout is built';
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

-- -- Handing a team's captaincy on ----------------------------------------------------------------------
-- The substitution function refuses to take out a captain, because a team without one cannot do the
-- things a captain does (invite, rename, read the entry code). This is the other half of that: an
-- administrator - asked in Discord, as everything else here is - names another member of the roster.
-- The entry code stays with the TEAM, so the new captain can read it from the moment they take over.
create or replace function public.hand_over_tournament_captaincy(p_entrant uuid, p_new_captain uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
  e_status text;
  t_status text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can change a team''s captain';
  end if;

  select e.tournament_id, e.status into tid, e_status from tournament_entrants e where e.id = p_entrant;
  if tid is null then
    raise exception 'There is no such team';
  end if;
  if e_status not in ('pending', 'approved') then
    raise exception 'That team is not in the event';
  end if;
  select t.status into t_status from tournaments t where t.id = tid;
  if t_status not in ('signup', 'live') then
    raise exception 'Captains can only be changed while an event is taking signups or running';
  end if;
  if not exists (select 1 from tournament_roster r where r.entrant_id = p_entrant and r.user_id = p_new_captain) then
    raise exception 'The new captain has to be on the team already';
  end if;
  if exists (select 1 from tournament_roster r where r.entrant_id = p_entrant and r.user_id = p_new_captain and r.is_captain) then
    raise exception 'That player is already the captain';
  end if;

  update tournament_roster set is_captain = (user_id = p_new_captain) where entrant_id = p_entrant;
  update tournament_entrants set captain_user_id = p_new_captain where id = p_entrant;
end;
$$;

grant execute on function public.hand_over_tournament_captaincy(uuid, uuid) to authenticated;
