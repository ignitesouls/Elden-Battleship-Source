-- Official matches: a room that is playing a real bracket match.
--
-- A host opens an ordinary room and, while a tournament is running, can make it OFFICIAL by entering
-- their team's entry code. The opposing team's captain enters theirs, the room takes the tournament's
-- rules, only rostered players may sit in it, and when the game is archived the result is written into
-- the bracket - which advances by itself.
--
-- -- The credential --------------------------------------------------------------------------------
-- Each approved team has an entry code (tournament_entrant_secrets, readable by admins and the team's
-- own captain). Entering it is what says "this room is playing that team's match". Both teams must do
-- it before the match can start, so neither side can claim a match on the other's behalf and a stranger
-- cannot open a room that scores into somebody's bracket. Codes are only unique within an EVENT, so the
-- caller says which event first; and wrong guesses are counted, because a six-character code that can be
-- guessed at without limit is not much of a code.
--
-- -- What is not touched ------------------------------------------------------------------------------
-- archive_match, which has been rewritten ten times and is not to be rewritten again for this. The
-- result is picked up by a trigger on match_reports, where every archived match lands exactly once.
-- And that trigger can NEVER stop a match being archived: a tournament error - a frozen bracket, a
-- match already decided - is caught and written to official_result_failures for an administrator to
-- apply by hand, instead of rolling back a real game's record.

-- ===========================================================================
--  Columns
-- ===========================================================================
alter table public.rooms
  add column if not exists tournament_match_id uuid references public.tournament_matches(id) on delete set null,
  add column if not exists official_a_confirmed boolean not null default false,
  add column if not exists official_b_confirmed boolean not null default false,
  -- Which fleet (team index in the room) each entrant sits on. Set by whichever rostered player sits
  -- first, and binding from then on: an entrant cannot be on two fleets, nor two entrants on one.
  add column if not exists official_team_a int,
  add column if not exists official_team_b int;

comment on column public.rooms.tournament_match_id is
  'The bracket match this room is playing, if it is an official match. Set and cleared only by link_official_room / unlink_official_room and by the result trigger.';

alter table public.match_reports
  add column if not exists official boolean not null default false,
  add column if not exists tournament_match_id uuid;

alter table public.match_participants
  add column if not exists official boolean not null default false;

create index if not exists match_participants_official_idx on public.match_participants (user_id) where official;

-- ===========================================================================
--  Wrong-code throttle, and results that could not be recorded
-- ===========================================================================
create table if not exists public.official_code_attempts (
  user_id uuid not null,
  at      timestamptz not null default now()
);
create index if not exists official_code_attempts_idx on public.official_code_attempts (user_id, at desc);
alter table public.official_code_attempts enable row level security;
-- No policies: only the functions below (running as the owner) read or write it.

create table if not exists public.official_result_failures (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  match_key           text,
  room_code           text,
  tournament_match_id uuid,
  winner_team         int,
  error               text not null,
  resolved            boolean not null default false
);
alter table public.official_result_failures enable row level security;
drop policy if exists "official failures select" on public.official_result_failures;
create policy "official failures select" on public.official_result_failures for select using (public.is_admin());
drop policy if exists "official failures resolve" on public.official_result_failures;
create policy "official failures resolve" on public.official_result_failures for update
  using (public.is_admin()) with check (public.is_admin());

-- ===========================================================================
--  The guard on rooms
-- ===========================================================================
-- Invoker, not definer, like the other room guards: inside a definer function current_user is the
-- owner, and this has to tell a browser's direct write (authenticated, refused) from one of the
-- functions below (owner, allowed). The RLS policy on rooms lets any seated player update the row, so
-- without this a player could simply set tournament_match_id on their own room and be "official".
create or replace function public.guard_official_room()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.tournament_match_id is not null or new.official_a_confirmed or new.official_b_confirmed
       or new.official_team_a is not null or new.official_team_b is not null then
      raise exception 'A room becomes an official match through the official match controls, not directly';
    end if;
    return new;
  end if;

  if new.tournament_match_id is distinct from old.tournament_match_id
     or new.official_a_confirmed is distinct from old.official_a_confirmed
     or new.official_b_confirmed is distinct from old.official_b_confirmed
     or new.official_team_a is distinct from old.official_team_a
     or new.official_team_b is distinct from old.official_team_b then
    raise exception 'A room becomes an official match through the official match controls, not directly';
  end if;

  if old.tournament_match_id is null then
    return new;
  end if;

  -- From here the room IS official.
  if new.board_size is distinct from old.board_size
     or new.ship_defs is distinct from old.ship_defs
     or new.starting_seconds is distinct from old.starting_seconds
     or new.prep_seconds is distinct from old.prep_seconds
     or new.square_set is distinct from old.square_set then
    raise exception 'This is an official match - its settings are fixed by the tournament';
  end if;

  if new.practice then
    raise exception 'An official match cannot be a practice match';
  end if;

  -- Leaving the lobby is the start of the match, and both teams have to have agreed to play it.
  if old.status = 'lobby' and new.status <> 'lobby'
     and not (old.official_a_confirmed and old.official_b_confirmed) then
    raise exception 'Both teams have to enter their entry codes before an official match can start';
  end if;

  return new;
end;
$$;

drop trigger if exists rooms_guard_official on public.rooms;
create trigger rooms_guard_official
  before insert or update on public.rooms
  for each row execute function public.guard_official_room();

-- ===========================================================================
--  Only the two rosters may take a seat
-- ===========================================================================
-- A player with no team is a spectator, and anyone may spectate. Taking a seat in an official match
-- needs a place on one of the two rosters, and the seats are then bound: whichever fleet a team's first
-- player sits on is that team's fleet for the match.
create or replace function public.guard_official_roster()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r rooms%rowtype;
  m tournament_matches%rowtype;
  on_a boolean;
  on_b boolean;
begin
  if public.is_service_session() or new.team is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.team is not distinct from old.team then
    return new;
  end if;

  select * into r from rooms where id = new.room_id;
  if r.tournament_match_id is null then
    return new;
  end if;
  select * into m from tournament_matches where id = r.tournament_match_id;

  on_a := exists (select 1 from tournament_roster x where x.entrant_id = m.entrant_a and x.user_id = new.user_id);
  on_b := exists (select 1 from tournament_roster x where x.entrant_id = m.entrant_b and x.user_id = new.user_id);
  if not on_a and not on_b then
    raise exception 'This is an official match - only players on one of the two teams can take a seat. You can still watch.';
  end if;

  if on_a then
    if r.official_team_a is null then
      if r.official_team_b is not distinct from new.team then
        raise exception 'That fleet belongs to the other team';
      end if;
      update rooms set official_team_a = new.team where id = r.id;
    elsif r.official_team_a <> new.team then
      raise exception 'Your team is on a different fleet in this match';
    end if;
  else
    if r.official_team_b is null then
      if r.official_team_a is not distinct from new.team then
        raise exception 'That fleet belongs to the other team';
      end if;
      update rooms set official_team_b = new.team where id = r.id;
    elsif r.official_team_b <> new.team then
      raise exception 'Your team is on a different fleet in this match';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists players_guard_official_roster on public.players;
create trigger players_guard_official_roster
  before insert or update of team on public.players
  for each row execute function public.guard_official_roster();

-- ===========================================================================
--  Linking a room to a match
-- ===========================================================================
-- Returns a small JSON answer rather than raising for a wrong code: a raised error rolls the
-- transaction back, and with it the record of the wrong guess that the throttle depends on.

create or replace function public.official_code_locked(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (select count(*) from official_code_attempts a where a.user_id = p_user and a.at > now() - interval '1 hour') >= 8;
$$;

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
         -- The tournament's timers, where it states them. A room only takes what the tournament says.
         -- Deliberately NOT the board size: a board size cannot change on its own, the fleet has to be
         -- rebuilt for it (the lobby's own settings change both in one write), and copying one without
         -- the other could leave a 14x14 board with a fleet made for 10x10. The size the host chose is
         -- what gets locked.
         starting_seconds = coalesce((t.match_settings ->> 'starting_seconds')::int, starting_seconds),
         prep_seconds     = coalesce((t.match_settings ->> 'prep_seconds')::int, prep_seconds),
         square_set       = coalesce(t.match_settings ->> 'square_set', square_set)
   where id = p_room;

  select en.name into ea from tournament_entrants en where en.id = m.entrant_a;
  select en.name into eb from tournament_entrants en where en.id = m.entrant_b;
  return jsonb_build_object('ok', true, 'match_key', m.key, 'team_a', ea, 'team_b', eb, 'you_are', side);
end;
$$;

grant execute on function public.link_official_room(uuid, uuid, text) to anon, authenticated;

-- The other team's captain (or anyone from that team) confirms from inside the room.
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
  want := case when r.official_a_confirmed then m.entrant_b else m.entrant_a end;
  mine := case when r.official_a_confirmed then m.entrant_a else m.entrant_b end;

  if public.official_code_locked(auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong codes - try again in an hour, or ask an administrator');
  end if;

  if exists (select 1 from tournament_entrant_secrets s where s.entrant_id = mine and s.entry_code = code) then
    return jsonb_build_object('ok', false, 'error', 'That is the code of the team that opened this room - the other team has to enter theirs');
  end if;
  if not exists (select 1 from tournament_entrant_secrets s where s.entrant_id = want and s.entry_code = code) then
    insert into official_code_attempts (user_id) values (auth.uid());
    return jsonb_build_object('ok', false, 'error', 'That code is not right for the team you are playing');
  end if;

  update rooms
     set official_a_confirmed = official_a_confirmed or (want = m.entrant_a),
         official_b_confirmed = official_b_confirmed or (want = m.entrant_b)
   where id = p_room;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.confirm_official_team(uuid, text) to anon, authenticated;

-- Take a room back to being an ordinary one. The host can, until the match starts; an administrator can
-- at any time (a stuck room, a wrong link).
create or replace function public.unlink_official_room(p_room uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r rooms%rowtype;
  host boolean;
begin
  select * into r from rooms where id = p_room for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'There is no such room');
  end if;
  host := exists (select 1 from players x where x.room_id = p_room and x.user_id = auth.uid() and x.is_host);
  if not (public.is_admin() or (host and r.status = 'lobby')) then
    return jsonb_build_object('ok', false, 'error', 'Only the host, before the match starts, or an administrator can do that');
  end if;
  update rooms
     set tournament_match_id = null, official_a_confirmed = false, official_b_confirmed = false,
         official_team_a = null, official_team_b = null
   where id = p_room;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.unlink_official_room(uuid) to anon, authenticated;

-- ===========================================================================
--  The result
-- ===========================================================================
-- Marks a report and its participants as official at the moment they are written. BEFORE INSERT, so
-- the flag is part of the row rather than an update that could be missed.
create or replace function public.match_report_official()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  linked uuid;
begin
  select r.tournament_match_id into linked from rooms r where r.code = new.room_code;
  if linked is not null and not coalesce(new.practice, false) and not coalesce(new.voided, false) then
    new.official := true;
    new.tournament_match_id := linked;
  end if;
  return new;
end;
$$;

drop trigger if exists match_reports_official on public.match_reports;
create trigger match_reports_official
  before insert on public.match_reports
  for each row execute function public.match_report_official();

create or replace function public.participant_official()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.official := exists (select 1 from match_reports r where r.match_key = new.match_key and r.official);
  return new;
end;
$$;

drop trigger if exists match_participants_official on public.match_participants;
create trigger match_participants_official
  before insert on public.match_participants
  for each row execute function public.participant_official();

-- Writes an official game's result into the bracket. Runs AFTER the report is stored, and whatever goes
-- wrong in here is caught: the record of a real game must never be lost to a tournament error.
create or replace function public.record_official_result()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r rooms%rowtype;
  side text;
  match_status text;
begin
  if not new.official then
    return new;
  end if;

  begin
    select * into r from rooms where code = new.room_code;
    if not found then
      raise exception 'the room is gone';
    end if;
    if new.winner_team is null then
      -- Nobody won (an abandoned game). There is nothing to record; the series is not advanced.
      return new;
    end if;
    side := case
      when new.winner_team = r.official_team_a then 'a'
      when new.winner_team = r.official_team_b then 'b'
      else null end;
    if side is null then
      raise exception 'the winning fleet (%) is not one of the two teams'' seats', new.winner_team;
    end if;

    perform public.tournament_record_game(new.tournament_match_id, side);

    select status into match_status from tournament_matches where id = new.tournament_match_id;
    if match_status = 'done' then
      -- The series is decided: the room is an ordinary room again.
      update rooms
         set tournament_match_id = null, official_a_confirmed = false, official_b_confirmed = false,
             official_team_a = null, official_team_b = null
       where id = r.id;
    end if;
  exception when others then
    insert into official_result_failures (match_key, room_code, tournament_match_id, winner_team, error)
    values (new.match_key, new.room_code, new.tournament_match_id, new.winner_team, sqlerrm);
  end;
  return new;
end;
$$;

drop trigger if exists match_reports_record_official on public.match_reports;
create trigger match_reports_record_official
  after insert on public.match_reports
  for each row execute function public.record_official_result();

-- ===========================================================================
--  Room pruning and the room cap
-- ===========================================================================
-- An official room has to outlive the hour of silence that reaps an ordinary one: a team may open the
-- room on Monday and play on Wednesday, and a bracket match must not lose its room to the sweeper. It
-- also must not take one of the fifteen slots, or a busy round of matches would lock ordinary players
-- out. So official rooms are exempt from the cap, and from the sweep - but not forever: a room that has
-- had no activity at all for three days is a forgotten one, and goes.
--
-- Both functions are reproduced in full (create or replace cannot patch a body). The only changes are
-- the tournament_match_id tests marked below.
create or replace function public.prune_stale_rooms()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  with activity as (
    select
      r.id,
      r.status,
      r.tournament_match_id,
      greatest(
        r.created_at,
        coalesce((select max(a.created_at) from attacks a where a.room_id = r.id), r.created_at),
        coalesce((select max(p.joined_at)  from players p where p.room_id = r.id), r.created_at)
      ) as last_active
    from rooms r
  ),
  dead as (
    delete from rooms r
    using activity act
    where act.id = r.id
      and act.last_active < case
            -- CHANGED: an official room gets three days of silence, not an hour.
            when act.tournament_match_id is not null then now() - interval '3 days'
            when act.status = 'finished' then now() - interval '10 minutes'
            else now() - interval '1 hour'
          end
    returning 1
  )
  select count(*) into removed from dead;

  delete from match_reports where finished_at < now() - interval '30 days';

  return removed;
end;
$$;

revoke all on function public.prune_stale_rooms() from public;

create or replace function public.enforce_room_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  max_rooms constant integer := 15;
  room_count integer;
begin
  perform public.prune_stale_rooms();

  -- CHANGED: official rooms do not count against the cap.
  select count(*) into room_count from rooms where tournament_match_id is null;

  if room_count >= max_rooms then
    -- check_violation (23514), NOT unique_violation (23505): createRoom() retries on 23505 to
    -- dodge room-code collisions, and a capacity error must break out of that loop immediately
    -- instead of silently burning all five attempts and surfacing as a code-allocation failure.
    raise exception
      'All % game rooms are currently in use. Rooms are cleared automatically after an hour of inactivity - try again in a bit, or join an existing room with its code.',
      max_rooms
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ===========================================================================
--  The Official record
-- ===========================================================================
-- Wins and games per player in official matches. Read from match_participants (which outlives the
-- 30-day sweep of match_reports) and leaving out any match an administrator has voided. Public, like the
-- rest of the leaderboard data; whether it is SHOWN is decided by official_stats_enabled().
create or replace function public.official_leaderboard()
returns table (player_key text, display_name text, played bigint, wins bigint)
language sql
stable
security definer
set search_path = public
as $$
  -- The same key the rest of the site uses (see participantKey in lib/careerStats): the account when there
  -- is one, else the lower-cased nickname.
  select coalesce(mp.user_id::text, 'name:' || lower(btrim(mp.nickname))) as player_key,
         coalesce(max(p.display_name), max(mp.nickname)) as display_name,
         count(*) as played,
         count(*) filter (where mp.won) as wins
    from match_participants mp
    left join profiles p on p.id = mp.user_id
   where mp.official
     and not exists (select 1 from match_reports r where r.match_key = mp.match_key and r.voided)
   group by 1
   order by wins desc, played asc
   limit 200;
$$;

grant execute on function public.official_leaderboard() to anon, authenticated;
