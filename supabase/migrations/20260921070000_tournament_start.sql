-- Starting an event: the one moment it stops being a signup and becomes a bracket.
--
-- Starting is the most consequential thing an administrator does to an event, and it is many writes at
-- once: every approved team gets its seed, the format and schedule are saved, the first stage's matches
-- are drawn, and the event goes live. Done as separate requests from a browser, a failure in the middle
-- would leave a half-started event - seeds set but no matches, or matches but still "signup" - with
-- nothing to say which. So it is one function, and it either does all of it or none of it.
--
-- -- Administrators only, checked here --------------------------------------------------------------
-- Row-level security already means a non-admin cannot update an event or write bracket rows. This does
-- not lean on that. The function checks is_admin() itself, so it would still refuse a stranger if a
-- policy elsewhere were ever loosened - "only admins may start an event" is a rule of this function, not
-- a side effect of somebody else's.
--
-- -- Where the bracket comes from -------------------------------------------------------------------
-- The matches are drawn in the administrator's browser by the engine in src/lib/tournament, and handed
-- over here as data. The database does not re-derive them; it checks what it can cheaply check (every
-- team named is a real, approved team of THIS event, and every approved team is seeded) and stores them.
-- An administrator is trusted with the shape of their own bracket.

create or replace function public.start_tournament(
  p_tournament uuid,
  p_format     jsonb,
  p_schedule   jsonb,
  p_seeds      jsonb,
  p_matches    jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  t_status   text;
  seeded     uuid[];
  approved   uuid[];
  inserted   int;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can start an event';
  end if;

  select t.status into t_status from tournaments t where t.id = p_tournament for update;
  if t_status is null then
    raise exception 'There is no such event';
  end if;
  if t_status <> 'signup' then
    raise exception 'Only an event taking signups can be started (this one is %)', t_status;
  end if;

  if jsonb_typeof(p_format -> 'qualifier') is distinct from 'object' then
    raise exception 'The format is missing its qualifier';
  end if;
  if jsonb_typeof(p_schedule) is distinct from 'object' then
    raise exception 'The schedule is not valid';
  end if;
  if jsonb_typeof(p_seeds) is distinct from 'array' or jsonb_typeof(p_matches) is distinct from 'array' then
    raise exception 'The seeds and matches must be lists';
  end if;

  -- Every approved team that is still in the event must be seeded, and nobody else may be.
  select coalesce(array_agg(x::uuid order by ord), '{}') into seeded
    from jsonb_array_elements_text(p_seeds) with ordinality as s(x, ord);
  select coalesce(array_agg(e.id), '{}') into approved
    from tournament_entrants e
   where e.tournament_id = p_tournament and e.status = 'approved' and e.forfeited_at is null;

  if coalesce(array_length(approved, 1), 0) < 2 then
    raise exception 'An event needs at least two approved teams to start';
  end if;
  if array_length(seeded, 1) is distinct from array_length(approved, 1)
     or not (seeded <@ approved and approved <@ seeded) then
    raise exception 'Every approved team has to be seeded, once, and nobody else';
  end if;

  -- Seeds first: clear, then assign, so the unique index on (event, seed) is never asked to hold two
  -- teams in one seat part-way through.
  update tournament_entrants set seed = null where tournament_id = p_tournament;
  for i in 1 .. array_length(seeded, 1) loop
    update tournament_entrants set seed = i where id = seeded[i];
  end loop;

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

  if inserted = 0 then
    raise exception 'There are no matches to start with';
  end if;

  -- A match may only name teams that are in this event. Checked after the insert so the whole thing
  -- rolls back if it fails.
  if exists (
    select 1 from tournament_matches m
     where m.tournament_id = p_tournament
       and ((m.entrant_a is not null and not (m.entrant_a = any(seeded)))
         or (m.entrant_b is not null and not (m.entrant_b = any(seeded)))
         or (m.winner is not null and not (m.winner = any(seeded))))
  ) then
    raise exception 'A match names a team that is not in this event';
  end if;

  update tournaments
     set format = p_format,
         schedule = p_schedule,
         status = 'live',
         starts_at = coalesce(starts_at, now())
   where id = p_tournament;

  return inserted;
end;
$$;

grant execute on function public.start_tournament(uuid, jsonb, jsonb, jsonb, jsonb) to authenticated;
