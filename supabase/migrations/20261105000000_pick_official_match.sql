-- The host picks which match a room plays.
--
-- link_official_room used to link a room to the host's team's EARLIEST open match. In a group stage every
-- match is ready from the first day, so a team with two or more waiting could only ever play the first:
-- a host meaning to play their round 3 opponent got linked to round 2, and the opponent actually sitting
-- in the room was told their code was wrong.
--
-- Now one entry code still opens the door, and when the team has more than one match waiting the host
-- chooses:
--   - one match waiting       -> linked straight away, as before;
--   - several, none chosen    -> nothing is linked; the answer lists them (choose: true) for the lobby to
--                                offer, and the host calls again with p_match;
--   - p_match given           -> it has to be one of THIS team's matches waiting to be played.
-- The list is only ever sent after the code has been checked, and a right code with a choice to make is
-- not a wrong guess, so the throttle never counts it. The other team still confirms with its own code
-- (confirm_official_team, unchanged), which is what makes the choice safe: the room can only start once
-- the team the host picked has said yes.
--
-- A tab still on the old site calls with three arguments; the default lets it through, and when there is a
-- choice to make it gets words saying to reload.

drop function if exists public.link_official_room(uuid, uuid, text);

create or replace function public.link_official_room(p_room uuid, p_tournament uuid, p_code text, p_match uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r rooms%rowtype;
  t tournaments%rowtype;
  ent tournament_entrants%rowtype;
  m tournament_matches%rowtype;
  waiting int;
  side text;
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

  select * into t from tournaments where id = p_tournament;
  if not found or t.status <> 'live' then
    return jsonb_build_object('ok', false, 'error', 'That event is not running');
  end if;

  -- The event's board, settled against the room's before anything else is checked, so a room that
  -- cannot play it is told why without a code being spent.
  b := public.official_board(r.square_set, r.board_size, r.ship_defs, coalesce(t.match_settings, '{}'::jsonb));
  if not (b ->> 'ok')::boolean then
    return jsonb_build_object('ok', false, 'error', b ->> 'error');
  end if;

  if public.official_code_locked(auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong codes - try again in an hour, or ask an administrator');
  end if;

  select e.* into ent
    from tournament_entrant_secrets s
    join tournament_entrants e on e.id = s.entrant_id
   where s.tournament_id = p_tournament
     and s.entry_code = upper(btrim(coalesce(p_code, '')))
     and e.status = 'approved' and e.forfeited_at is null;
  if not found then
    insert into official_code_attempts (user_id) values (auth.uid());
    return jsonb_build_object('ok', false, 'error', 'That code is not right for this event');
  end if;

  -- The team's matches waiting to be played: open, with both teams known.
  select count(*) into waiting from tournament_matches x
   where x.tournament_id = p_tournament
     and x.status in ('ready', 'in_progress')
     and x.entrant_a is not null and x.entrant_b is not null
     and (x.entrant_a = ent.id or x.entrant_b = ent.id);
  if waiting = 0 then
    return jsonb_build_object('ok', false, 'error', 'That team has no match waiting to be played');
  end if;

  if p_match is null and waiting > 1 then
    return jsonb_build_object(
      'ok', false,
      'choose', true,
      'error', 'Your team has more than one match waiting - reload the page to pick which one this room plays',
      'group_names', to_jsonb(t.group_names),
      'matches', (
        select jsonb_agg(jsonb_build_object(
                 'id', x.id, 'stage', x.stage, 'grp', x.grp, 'round', x.round,
                 'opponent', o.name, 'agreed_at', x.agreed_at)
               order by x.phase, x.idx)
          from tournament_matches x
          join tournament_entrants o on o.id = case when x.entrant_a = ent.id then x.entrant_b else x.entrant_a end
         where x.tournament_id = p_tournament
           and x.status in ('ready', 'in_progress')
           and x.entrant_a is not null and x.entrant_b is not null
           and (x.entrant_a = ent.id or x.entrant_b = ent.id)));
  end if;

  select * into m from tournament_matches x
   where x.tournament_id = p_tournament
     and x.status in ('ready', 'in_progress')
     and x.entrant_a is not null and x.entrant_b is not null
     and (x.entrant_a = ent.id or x.entrant_b = ent.id)
     and (p_match is null or x.id = p_match)
   order by x.phase, x.idx
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'That match is not one of your team''s matches waiting to be played');
  end if;
  side := case when m.entrant_a = ent.id then 'a' else 'b' end;

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
         official_a_confirmed = (side = 'a'),
         official_b_confirmed = (side = 'b'),
         official_team_a = team_a,
         official_team_b = team_b,
         -- Whatever the tournament states; the board as official_board settled it (see 20261006000000).
         starting_seconds = coalesce((t.match_settings ->> 'starting_seconds')::int, starting_seconds),
         prep_seconds     = coalesce((t.match_settings ->> 'prep_seconds')::int, prep_seconds),
         square_set       = coalesce(t.match_settings ->> 'square_set', square_set),
         board_size       = (b ->> 'board_size')::int,
         ship_defs        = b -> 'ship_defs'
   where id = p_room;

  select en.name into ea from tournament_entrants en where en.id = m.entrant_a;
  select en.name into eb from tournament_entrants en where en.id = m.entrant_b;
  return jsonb_build_object('ok', true, 'match_key', m.key, 'team_a', ea, 'team_b', eb, 'you_are', side);
end;
$$;

grant execute on function public.link_official_room(uuid, uuid, text, uuid) to anon, authenticated;
