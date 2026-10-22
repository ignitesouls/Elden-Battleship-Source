-- An approved caster opens an official match's lobby from their desk.
--
-- Until now a room became official only when its host typed their own team's entry code, so the host had
-- to be a player. A caster approved for a match (official_casts, see 20261021000000) is now trusted to open
-- it too: their desk lists the matches they are casting, one click makes a room and links it, and the
-- caster sits in it as the spectating host. No code is typed by the caster - the approval is the permission.
--
-- The teams still prove they are there: a caster-opened room starts with NEITHER team confirmed, and each
-- team's captain enters their own entry code in the lobby. guard_official_room already refuses to start a
-- match until both have, so nothing about starting changes.
--
--   my_cast_matches       the caller's approved casts that are waiting to be played, with any lobby already open
--   link_cast_room        link_official_room for an approved caster, without a code, both sides unconfirmed
--   confirm_official_team rewritten so it also takes EITHER team's code while neither has confirmed

-- ===========================================================================
--  The caster's matches
-- ===========================================================================
create or replace function public.my_cast_matches()
returns table (
  match_id      uuid,
  tournament_id uuid,
  event_name    text,
  team_a_name   text,
  team_b_name   text,
  best_of       int,
  score_a       int,
  score_b       int,
  agreed_at     timestamptz,
  room_code     text
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.tournament_id, t.name, ea.name, eb.name, m.best_of, m.score_a, m.score_b, m.agreed_at,
         (select r.code from rooms r where r.tournament_match_id = m.id order by r.created_at desc limit 1)
    from official_casts c
    join tournament_matches m on m.id = c.match_id
    join tournaments t on t.id = m.tournament_id
    join tournament_entrants ea on ea.id = m.entrant_a
    join tournament_entrants eb on eb.id = m.entrant_b
   where c.caster_user_id = auth.uid()
     and c.status = 'approved'
     and t.status = 'live'
     and m.status in ('ready', 'in_progress')
   order by m.agreed_at nulls last, m.phase, m.idx;
$$;

grant execute on function public.my_cast_matches() to authenticated;

-- ===========================================================================
--  Linking, as the caster
-- ===========================================================================
-- The checks of link_official_room (20261006000000), with the entry code replaced by the caster's
-- approval for this exact match - so there is no code to guess and no throttle to count against.
create or replace function public.link_cast_room(p_room uuid, p_match uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r rooms%rowtype;
  t tournaments%rowtype;
  m tournament_matches%rowtype;
  team_a int;
  team_b int;
  p record;
  ea text;
  eb text;
  b jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'Sign in first');
  end if;
  select * into r from rooms where id = p_room for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'There is no such room');
  end if;
  if not exists (select 1 from players x where x.room_id = p_room and x.user_id = auth.uid() and x.is_host) then
    return jsonb_build_object('ok', false, 'error', 'Only the host can make this an official match');
  end if;
  if r.status <> 'lobby' then
    return jsonb_build_object('ok', false, 'error', 'An official match has to be set up in the lobby, before it starts');
  end if;
  if r.tournament_match_id is not null then
    return jsonb_build_object('ok', false, 'error', 'This room is already an official match');
  end if;
  if r.practice then
    return jsonb_build_object('ok', false, 'error', 'Turn off practice first - an official match cannot be a practice match');
  end if;

  if not exists (select 1 from official_casts c
                  where c.match_id = p_match and c.caster_user_id = auth.uid() and c.status = 'approved') then
    return jsonb_build_object('ok', false, 'error', 'You are not an approved caster for that match');
  end if;

  select * into m from tournament_matches where id = p_match;
  if not found or m.status not in ('ready', 'in_progress') or m.entrant_a is null or m.entrant_b is null then
    return jsonb_build_object('ok', false, 'error', 'That match isn''t waiting to be played');
  end if;
  select * into t from tournaments where id = m.tournament_id;
  if not found or t.status <> 'live' then
    return jsonb_build_object('ok', false, 'error', 'That event is not running');
  end if;

  -- One lobby per match. A co-caster, or a team that got there first, has already made it - join that one.
  if exists (select 1 from rooms x where x.tournament_match_id = p_match and x.id <> p_room) then
    return jsonb_build_object('ok', false, 'error', 'This match already has a lobby - join that one instead');
  end if;

  b := public.official_board(r.square_set, r.board_size, r.ship_defs, coalesce(t.match_settings, '{}'::jsonb));
  if not (b ->> 'ok')::boolean then
    return jsonb_build_object('ok', false, 'error', b ->> 'error');
  end if;

  -- Anyone already seated has to be on one of the two rosters, and consistently.
  for p in select x.user_id, x.team from players x where x.room_id = p_room and x.team is not null loop
    if exists (select 1 from tournament_roster q where q.entrant_id = m.entrant_a and q.user_id = p.user_id) then
      if team_a is not null and team_a <> p.team then
        return jsonb_build_object('ok', false, 'error', 'The players seated in this room do not match the two rosters - have everyone move to spectators, then try again');
      end if;
      team_a := p.team;
    elsif exists (select 1 from tournament_roster q where q.entrant_id = m.entrant_b and q.user_id = p.user_id) then
      if team_b is not null and team_b <> p.team then
        return jsonb_build_object('ok', false, 'error', 'The players seated in this room do not match the two rosters - have everyone move to spectators, then try again');
      end if;
      team_b := p.team;
    else
      return jsonb_build_object('ok', false, 'error', 'Someone seated in this room is not on either team - have them move to spectators, then try again');
    end if;
  end loop;
  if team_a is not null and team_a = team_b then
    return jsonb_build_object('ok', false, 'error', 'Both teams are seated on the same fleet - fix the seating, then try again');
  end if;

  update rooms
     set tournament_match_id = m.id,
         -- Neither: the caster is nobody's team, so both captains confirm with their own codes.
         official_a_confirmed = false,
         official_b_confirmed = false,
         official_team_a = team_a,
         official_team_b = team_b,
         starting_seconds = coalesce((t.match_settings ->> 'starting_seconds')::int, starting_seconds),
         prep_seconds     = coalesce((t.match_settings ->> 'prep_seconds')::int, prep_seconds),
         square_set       = coalesce(t.match_settings ->> 'square_set', square_set),
         board_size       = (b ->> 'board_size')::int,
         ship_defs        = b -> 'ship_defs'
   where id = p_room;

  select en.name into ea from tournament_entrants en where en.id = m.entrant_a;
  select en.name into eb from tournament_entrants en where en.id = m.entrant_b;
  return jsonb_build_object('ok', true, 'match_key', m.key, 'team_a', ea, 'team_b', eb);
end;
$$;

grant execute on function public.link_cast_room(uuid, uuid) to authenticated;

-- ===========================================================================
--  Confirming, when nobody has yet
-- ===========================================================================
-- Reproduced in full from 20260922010000_official_matches.sql. The change: with neither team confirmed
-- (a caster opened the room), the code may be EITHER team's, and confirms that team. With one confirmed,
-- it behaves exactly as before.
create or replace function public.confirm_official_team(p_room uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r rooms%rowtype;
  m tournament_matches%rowtype;
  want uuid;
  mine uuid;
  code text := upper(btrim(coalesce(p_code, '')));
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'Sign in first');
  end if;
  select * into r from rooms where id = p_room for update;
  if not found or r.tournament_match_id is null then
    return jsonb_build_object('ok', false, 'error', 'This is not an official match');
  end if;
  if not exists (select 1 from players x where x.room_id = p_room and x.user_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'Join the room first');
  end if;
  if r.status <> 'lobby' then
    return jsonb_build_object('ok', false, 'error', 'The match has already started');
  end if;
  if r.official_a_confirmed and r.official_b_confirmed then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  select * into m from tournament_matches where id = r.tournament_match_id;

  if public.official_code_locked(auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong codes - try again in an hour, or ask an administrator');
  end if;

  -- CHANGED: nobody confirmed yet - whichever team's code this is.
  if not r.official_a_confirmed and not r.official_b_confirmed then
    select s.entrant_id into want
      from tournament_entrant_secrets s
     where s.entrant_id in (m.entrant_a, m.entrant_b) and s.entry_code = code;
    if want is null then
      insert into official_code_attempts (user_id) values (auth.uid());
      return jsonb_build_object('ok', false, 'error', 'That code is not right for either team in this match');
    end if;
  else
    want := case when r.official_a_confirmed then m.entrant_b else m.entrant_a end;
    mine := case when r.official_a_confirmed then m.entrant_a else m.entrant_b end;

    if exists (select 1 from tournament_entrant_secrets s where s.entrant_id = mine and s.entry_code = code) then
      return jsonb_build_object('ok', false, 'error', 'That team has already confirmed - the other team has to enter theirs');
    end if;
    if not exists (select 1 from tournament_entrant_secrets s where s.entrant_id = want and s.entry_code = code) then
      insert into official_code_attempts (user_id) values (auth.uid());
      return jsonb_build_object('ok', false, 'error', 'That code is not right for the team you are playing');
    end if;
  end if;

  update rooms
     set official_a_confirmed = official_a_confirmed or (want = m.entrant_a),
         official_b_confirmed = official_b_confirmed or (want = m.entrant_b)
   where id = p_room;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.confirm_official_team(uuid, text) to anon, authenticated;
