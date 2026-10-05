-- Two changes to how an organiser sets an event up.
--
-- -- 1. The event decides the board, not just the clock -----------------------------------------------
-- An event could already fix its official rooms' timers. It can now fix the square set, the board size
-- and the fleet too - each on its own, whatever the others are left as.
--
-- The three are not independent in a room: a set caps how big a board it can deal without repeating a
-- square, and a fleet is built for (or has to fit) its board. The lobby keeps them consistent whenever
-- a host changes one, and linking does exactly the same with whatever the event fixes:
--   - a fixed SET shrinks a host board that is too big for it to the set's ceiling (clampBoardSize);
--   - a board that changes size - fixed by the event, or shrunk for its set - refits the host's fleet:
--     a default fleet becomes the default for the new size, and a custom one is kept if it still fits
--     (refitFleet);
--   - a fixed FLEET replaces the host's.
-- What cannot be squared is refused, with the reason: a fixed size the host's squares cannot fill, or a
-- fixed fleet the room's board is too small to hold. All of it is one update, so the room is never a
-- 14x14 board carrying a 10x10 fleet in between. A room that has not left the lobby has no laid-out
-- fleet to disagree: fleets are rebuilt from the room row on the way out (reset_room_fleets).
--
-- Postgres knows neither the square sets nor the fleet presets, so the app saves the two lookups this
-- needs next to the rules (src/lib/tournament/matchRules.ts, toMatchSettings).
--
-- match_settings, as the app now writes it (every key optional):
--   prep_seconds, starting_seconds   the clock, as before
--   square_set                       the set every official room plays
--   board_size                       the board size every official room plays
--   ship_defs                        the fleet every official room plays
--   set_caps                         {set id: largest board}, for every set - whenever any of the three is
--   default_fleets                   {"5": fleet, ... "14": fleet}, fleetFor(n) - likewise
--
-- -- 2. No substitutes; pairs ------------------------------------------------------------------------
-- A roster is exactly the team: max_roster is pinned to team_size. The column stays, because seven
-- functions read it as "how many players a team may have", which is still the right question - the
-- answer just no longer has a second number in it. Existing rosters already over the size are left
-- alone (nobody is removed); they simply cannot grow.
--
-- In a three-player event two friends can now sign up as a PAIR: an entrant flagged
-- looking_for_players, captain plus one invited partner, which an administrator completes with a solo
-- player from the pool. Mechanically a pair is a short team - the pairing screen already tops those up
-- first - and the flag is what tells "we are two, find us a third" apart from "we are three, the third
-- hasn't accepted yet".

-- ===========================================================================
--  1. Rosters are exactly team_size
-- ===========================================================================
update public.tournaments set max_roster = team_size where max_roster is distinct from team_size;

alter table public.tournaments drop constraint if exists tournaments_roster_covers_team;
alter table public.tournaments drop constraint if exists tournaments_roster_is_team;
alter table public.tournaments add constraint tournaments_roster_is_team check (max_roster = team_size);

-- A trigger rather than leaving it to every writer, so an old client - or create_test_tournament,
-- which still asks for one spare place - cannot put a bench back. Named to sort ahead of
-- tournaments_guard_update, which compares max_roster against the old row on a running event.
create or replace function public.pin_max_roster()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.max_roster := new.team_size;
  return new;
end;
$$;

drop trigger if exists tournaments_a_roster_is_team on public.tournaments;
create trigger tournaments_a_roster_is_team
  before insert or update of team_size, max_roster on public.tournaments
  for each row execute function public.pin_max_roster();

-- ===========================================================================
--  2. Pairs
-- ===========================================================================
alter table public.tournament_entrants
  add column if not exists looking_for_players boolean not null default false;

comment on column public.tournament_entrants.looking_for_players is
  'Signed up as a pair: two players of a three-player team, waiting for an administrator to add a solo player from the pool.';

-- register_team gains p_pair. Dropped and re-made rather than overloaded: PostgREST picks a function by
-- its argument names, and two register_teams that both accept the first three would be ambiguous.
drop function if exists public.register_team(uuid, text, text[]);

create or replace function public.register_team(
  p_tournament uuid,
  p_name text,
  p_logins text[] default '{}',
  p_pair boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  eid uuid;
  size int;
  named int := 0;
  v_login text;
begin
  if not public.is_twitch_user() then
    raise exception 'Sign in with Twitch to sign a team up';
  end if;
  if not public.tournament_signup_open(p_tournament) then
    raise exception 'Signup for this event is not open';
  end if;

  if p_pair then
    select t.team_size into size from tournaments t where t.id = p_tournament;
    if size is distinct from 3 then
      raise exception 'Pairs can only sign up for events with teams of three';
    end if;
    foreach v_login in array coalesce(p_logins, '{}') loop
      if public.normalize_twitch_login(v_login) <> '' then
        named := named + 1;
      end if;
    end loop;
    if named <> 1 then
      raise exception 'A pair is you and one partner - name exactly one Twitch username';
    end if;
  end if;

  insert into tournament_entrants (tournament_id, name, captain_user_id, looking_for_players)
  values (p_tournament, p_name, auth.uid(), coalesce(p_pair, false))
  returning id into eid;

  if coalesce(array_length(p_logins, 1), 0) > 0 then
    perform public.invite_to_roster(eid, p_logins);
  end if;
  return eid;
end;
$$;

grant execute on function public.register_team(uuid, text, text[], boolean) to authenticated;

-- ===========================================================================
--  3. Linking takes the event's board
-- ===========================================================================
-- How much of the board a fleet covers, and its shape ("5,4,3,3,2") - the two things the lobby's fleet
-- rules look at (customFleetFits; presetNameOf compares shapes, not names).
create or replace function public.fleet_cells(p_ships jsonb)
returns int
language sql
immutable
as $$
  select coalesce(sum((s ->> 'size')::int), 0)::int from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) s;
$$;

create or replace function public.fleet_shape(p_ships jsonb)
returns text
language sql
immutable
as $$
  select coalesce(string_agg(s.e ->> 'size', ',' order by s.i), '')
    from jsonb_array_elements(coalesce(p_ships, '[]'::jsonb)) with ordinality as s(e, i);
$$;

-- The board a room plays once it takes an event's rules: {ok, square_set, board_size, ship_defs}, or
-- {ok: false, error}. Pure - the room's own settings in, the event's match_settings in - so linking is
-- the only thing that writes, and the rules can be read on their own. See the header for what each
-- fixed setting does; this is the SQL of clampBoardSize + refitFleet + customFleetFits.
create or replace function public.official_board(p_set text, p_size int, p_ships jsonb, p_rules jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  caps jsonb := p_rules -> 'set_caps';
  defaults jsonb := p_rules -> 'default_fleets';
  v_set text;
  v_cap int;
  v_size int;
  v_ships jsonb;
  need int;
begin
  -- The set: the event's, else the room's (a room with none plays the boss board, like the lobby).
  v_set := coalesce(p_rules ->> 'square_set', p_set, 'bosses');
  -- An id the lookup does not know falls back to the boss board's ceiling - squareSet()'s own fallback.
  v_cap := coalesce((caps ->> v_set)::int, (caps ->> 'bosses')::int);

  -- The size.
  if jsonb_typeof(p_rules -> 'board_size') = 'number' then
    v_size := (p_rules ->> 'board_size')::int;
    if v_cap is not null and v_size > v_cap then
      return jsonb_build_object('ok', false, 'error', format(
        'This event plays %sx%s boards, and the squares picked in this room only fill %sx%s - pick other squares in Match settings, then try again',
        v_size, v_size, v_cap, v_cap));
    end if;
  else
    v_size := p_size;
    if p_rules ? 'square_set' and v_cap is not null and v_size > v_cap then
      v_size := v_cap;
    end if;
  end if;

  -- The fleet.
  if jsonb_typeof(p_rules -> 'ship_defs') = 'array' then
    v_ships := p_rules -> 'ship_defs';
    if public.fleet_cells(v_ships) * 2 > v_size * v_size then
      need := greatest(5, ceil(sqrt(public.fleet_cells(v_ships) * 2.0))::int);
      return jsonb_build_object('ok', false, 'error', format(
        'This event''s fleet needs a board of at least %sx%s - pick a bigger board in Match settings, then try again',
        need, need));
    end if;
  elsif v_size = p_size then
    v_ships := p_ships;
  elsif public.fleet_shape(p_ships) <> public.fleet_shape(defaults -> (p_size::text))
        and public.fleet_cells(p_ships) > 0
        and public.fleet_cells(p_ships) * 2 <= v_size * v_size then
    v_ships := p_ships;
  else
    v_ships := coalesce(defaults -> (v_size::text), p_ships);
  end if;

  return jsonb_build_object('ok', true, 'square_set', v_set, 'board_size', v_size, 'ship_defs', v_ships);
end;
$$;

-- Reproduced in full from 20260922010000_official_matches.sql. The changes are the board check after
-- the event is found (official_board), and square_set / board_size / ship_defs in the final update.
create or replace function public.link_official_room(p_room uuid, p_tournament uuid, p_code text)
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

  -- The team's next match: the earliest open one with both teams known.
  select * into m from tournament_matches x
   where x.tournament_id = p_tournament
     and x.status in ('ready', 'in_progress')
     and x.entrant_a is not null and x.entrant_b is not null
     and (x.entrant_a = ent.id or x.entrant_b = ent.id)
   order by x.phase, x.idx
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'That team has no match waiting to be played');
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
         -- Whatever the tournament states; the board as official_board settled it, set, size and fleet
         -- together - see the header. A room that had no square set keeps none when the event left it
         -- to the host (null and 'bosses' deal the same board, but only null is what the host chose).
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

grant execute on function public.link_official_room(uuid, uuid, text) to anon, authenticated;
