-- A match that was never going to count, said so before the first shot.
--
-- The tool that existed for this was voiding, and voiding is the wrong shape for it. Voiding is a
-- verdict passed on a match AFTER it happened - RUSTYSQUALL's clock was fiction, so an admin struck
-- it - and everything about it is built for that: it is an admin power, it is reversible, and the
-- recap says "Voided", which reads as a match that went wrong. None of that describes a host
-- teaching four people where the fire button is.
--
-- The practical cost of having only the one tool is that every shakedown run, every "let me show you
-- how placement works", every test of a new square set had to be played as a real match and then
-- cleaned up afterwards - a trip through the Admin panel per test, remembered after the fact, by the
-- one person who knew it needed doing. A match that was never meant to count should not depend on
-- somebody's memory an hour later.
--
-- So: declared, not judged. The host flips it in the lobby, where the whole room can see it and
-- where it can still be changed, and it locks the moment the match starts.
--
-- -- Why it rides the voided rail -------------------------------------------------------------------
--
-- Because "counts for nothing" already exists and is already read by everything: careers, the
-- leaderboard, square pace, the record book, the boss stats, the heatmaps and the balance sweep all
-- filter on match_reports.voided (see lib/voidedMatches, and the balance-stats function). A second
-- exclusion flag would mean finding every one of those again, and would leave two ways for a match
-- to not count - which is how one of them ends up missed.
--
-- `practice` is therefore not a filter. It is a LABEL: it sets voided at archive time and then says
-- WHY, so the recap can read "Practice match" rather than "Voided" - which is the difference between
-- a page saying this was never a contest and a page saying this contest was thrown out.

-- ===========================================================================
--  The room's declaration
-- ===========================================================================
alter table public.rooms
  add column if not exists practice boolean not null default false;

comment on column public.rooms.practice is
  'Declared in the lobby: this match counts for nothing. Copied onto the match record by archive_match, which also voids it. Locked once the room leaves the lobby.';

-- ===========================================================================
--  The match's label
-- ===========================================================================
alter table public.match_reports
  add column if not exists practice boolean not null default false;

comment on column public.match_reports.practice is
  'Was a practice match, declared before it was played. Always accompanied by voided = true, which is what every stats reader filters on; this column only says why.';

-- ===========================================================================
--  Only the host, and only before the shooting starts
-- ===========================================================================
-- A trigger rather than a policy, for the reason guard_room_pause spells out: RLS cannot compare the
-- old row to the new one, so it cannot say "this column did not change" - and every other write to
-- `rooms` has to keep working untouched. Invoker rather than SECURITY DEFINER, likewise: inside a
-- definer function current_user is the owner and the host check below would pass for everybody.
--
-- The lobby-only half is the half that matters. A flag settable at any time would be a button that
-- deletes a match you have just lost, held by the person who runs the room - which is worse than
-- having no practice matches at all, because the leaderboard would then be a record of what the
-- hosts chose to keep. Before the first fleet is placed nobody knows anything worth deleting, so
-- that is where the decision has to live.
--
-- No is_admin() exemption, matching guard_fleet_reset. Retitling a match that is already being
-- played is not a power anybody needs, and the SQL editor stays exempt for a room that genuinely
-- has to be repaired by hand.
create or replace function public.guard_room_practice()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.practice is not distinct from old.practice then
    return new;
  end if;

  -- The SQL editor, a later migration, and the edge functions' service key.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if old.status is distinct from 'lobby' then
    raise exception 'This match has already left the lobby - whether it counts was settled before it started';
  end if;

  if not exists (
    select 1 from players p
     where p.room_id = new.id
       and p.user_id = auth.uid()
       and p.is_host
  ) then
    raise exception 'Only the host can set this match to practice';
  end if;

  return new;
end;
$$;

drop trigger if exists rooms_guard_practice on rooms;
create trigger rooms_guard_practice
  before update on rooms
  for each row execute function public.guard_room_practice();

-- ===========================================================================
--  A practice match stays a practice match
-- ===========================================================================
-- Voiding is reversible on purpose: an admin who strikes a match can put it back, because the
-- judgement that struck it might have been wrong. This is not that. A practice match was declared
-- before anyone knew how it would go, which is the entire reason its declaration can be trusted -
-- and a declaration that can be revised once the result is in is not a declaration, it is an option.
--
-- So the Admin panel's Restore button stops at this line, and it is disabled up there rather than
-- left to fail: a button that raises is a worse way of saying "no" than a button that does not
-- offer. The SQL editor stays exempt, for the host who ticked the wrong box on a real tournament
-- match and needs it put right by hand.
--
-- UPDATE only. archive_match inserts the row already carrying both flags, and runs as the owner in
-- any case; there is nothing here for it to trip over.
create or replace function public.guard_practice_record()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not old.practice then
    return new;
  end if;

  if new.practice and new.voided then
    return new;
  end if;

  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  raise exception 'Match % was played as practice - it cannot be entered into the record afterwards', old.match_key;
end;
$$;

drop trigger if exists match_reports_guard_practice on match_reports;
create trigger match_reports_guard_practice
  before update on match_reports
  for each row execute function public.guard_practice_record();

-- ===========================================================================
--  archive_match, carrying the declaration onto the record
-- ===========================================================================
-- Reproduced in full for the usual reason: `create or replace function` cannot patch a body. The
-- only change against the match_pause version is the match_reports insert, which now writes the two
-- new columns off the room.
--
-- Everything else about a practice match is archived exactly as a real one: the participants, the
-- fleets, the events, the prose. That is deliberate. The room is pruned about an hour after it goes
-- quiet, so anything not written here is gone - and the person most likely to want to look back at a
-- practice run is the host who just ran one to find out whether something worked.
create or replace function public.archive_match(
  p_room_id     uuid,
  p_report_text text  default '',
  p_summary     jsonb default '{}'::jsonb,
  p_awards      jsonb default '{}'::jsonb,
  p_challenges  jsonb default '[]'::jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room       rooms%rowtype;
  v_started_at timestamptz;
  v_last_shot  timestamptz;
  v_match_key  text;
  v_begins_at  int;
  v_total      int;
  v_duration   text;
  v_elapsed    int;
  v_square_set text;
  v_board_seed text;
  v_board_perm jsonb;
  v_balance    jsonb;
  v_pauses     jsonb;
begin
  select * into v_room from rooms where id = p_room_id;
  if not found then
    raise exception 'No such room';
  end if;

  if not public.is_admin()
     and not exists (
       select 1 from players p where p.room_id = p_room_id and p.user_id = auth.uid()
     )
  then
    raise exception 'Only players in this room can archive it';
  end if;

  -- The room is the authority on all four: which set was played, which seed dealt the board, how the
  -- balancer rearranged it, and what the balancer made of the result.
  v_square_set := coalesce(v_room.square_set, 'bosses');
  v_board_seed := v_room.seed;
  v_board_perm := v_room.board_perm;
  v_balance    := v_room.balance_report;

  select min(created_at) into v_started_at
    from attacks where room_id = p_room_id and cell_index = -1;

  v_match_key := v_room.code || ':' || coalesce(v_started_at::text, 'unknown');
  v_begins_at := coalesce(v_room.starting_seconds, 10) + coalesce(v_room.prep_seconds, 240);

  -- Every pause this match sat through. The closed ones are already in the log; an in-flight one is
  -- folded in here rather than left out, because a match can be archived while it is still stopped -
  -- a crew that pauses, talks it over and decides to call the game does exactly that, and the
  -- alternative is a recap that bills them for the conversation. A pause with no resume scheduled is
  -- closed at now(), which is as far as the clock could have run in any case.
  v_pauses := coalesce(v_room.pause_log, '[]'::jsonb);
  if v_room.pause_at is not null then
    v_pauses := v_pauses || jsonb_build_object(
      'at',    v_room.pause_at,
      'until', coalesce(v_room.resume_at, greatest(v_room.pause_at, now()))
    );
  end if;

  drop table if exists _shots;
  create temp table _shots on commit drop as
  select a.attacker_player_id,
         a.attacker_team,
         a.cell_index,
         a.created_at,
         bool_or(a.result in ('hit', 'sunk'))                as connected,
         bool_or(a.result = 'miss')                          as had_miss,
         count(*) filter (where a.result = 'sunk')::int       as sunk_count
    from attacks a
   where a.room_id = p_room_id
     and a.cell_index >= 0
   group by a.attacker_player_id, a.attacker_team, a.cell_index, a.created_at;

  select count(*), max(created_at) into v_total, v_last_shot from _shots;

  if v_total = 0 then
    return null;
  end if;

  if v_started_at is null then
    v_duration := '--:--';
  else
    -- The stopped time comes off the same way the countdown buffer does: what is recorded is the
    -- length of the match that was actually played, which is the number the record book ranks on.
    v_elapsed := greatest(0, floor(
                   extract(epoch from (v_last_shot - v_started_at))
                   - public.paused_seconds_before(v_pauses, v_last_shot)
                 )::int - v_begins_at);
    v_duration := public.duration_text(v_elapsed);
  end if;

  -- -- match_reports --------------------------------------------------------
  -- `voided` is written from the same flag rather than left for anything downstream to derive,
  -- because the readers that decide whether a match counts read only that column - a practice match
  -- that arrived labelled but not voided would be a practice match on the leaderboard.
  insert into match_reports (match_key, room_code, winner_team, duration, total_shots, summary, report_text, square_set, balance, practice, voided)
  values (v_match_key, v_room.code, v_room.winner_team, v_duration, v_total, p_summary, p_report_text, v_square_set, v_balance,
          coalesce(v_room.practice, false), coalesce(v_room.practice, false))
  on conflict (match_key) do nothing;

  -- A second archive of the same match is otherwise a no-op, and normally that is right. This one
  -- column is the exception: a room that was archived before the balancer wrote its record - an end
  -- match mid-placement, a replay of an older room - would keep a null forever, and the number is
  -- not recoverable from anywhere else once the room is pruned.
  update match_reports
     set balance = v_balance
   where match_key = v_match_key
     and balance is null
     and v_balance is not null;

  -- -- match_participants ---------------------------------------------------
  insert into match_participants (
    match_key, user_id, nickname, team, won, draw,
    shots, hits, misses, sunk, team_ships_lost, awards, room_code, square_set
  )
  select
    v_match_key,
    p.user_id,
    coalesce(p.nickname, 'Team ' || (s.attacker_team + 1)),
    s.attacker_team,
    v_room.winner_team is not null and s.attacker_team = v_room.winner_team,
    v_room.winner_team is null,
    count(*)::int,
    count(*) filter (where s.connected)::int,
    count(*) filter (where not s.connected and s.had_miss)::int,
    coalesce(sum(s.sunk_count), 0)::int,
    public.hulls_sunk(p_room_id, s.attacker_team),
    coalesce(p_awards -> coalesce(p.nickname, 'Team ' || (s.attacker_team + 1)), '[]'::jsonb),
    v_room.code,
    v_square_set
    from _shots s
    left join players p on p.id = s.attacker_player_id
   group by p.user_id, p.nickname, s.attacker_team
  on conflict (match_key, nickname, team) do nothing;

  -- -- match_fleets ---------------------------------------------------------
  insert into match_fleets (match_key, team, board_size, room_id, placements, ship_defs, square_set)
  select v_match_key, f.team, v_room.board_size, v_room.id,
         coalesce(f.placements, '[]'::jsonb), v_room.ship_defs, v_square_set
    from fleets f
   where f.room_id = p_room_id
  on conflict (match_key, team) do nothing;

  -- -- match_events ---------------------------------------------------------
  insert into match_events (
    match_key, user_id, nickname, team, cell_index, room_id,
    challenge_name, result, match_seconds, board_size, square_set, board_seed, board_perm
  )
  select
    v_match_key,
    p.user_id,
    coalesce(p.nickname, 'Team ' || (s.attacker_team + 1)),
    s.attacker_team,
    s.cell_index,
    v_room.id,
    nullif(p_challenges ->> s.cell_index, ''),
    case when s.sunk_count > 0 then 'sunk'
         when s.connected     then 'hit'
         when s.had_miss      then 'miss'
         else 'pending' end,
    -- Per shot rather than per match, and clamped at the shot's own instant: a square killed during
    -- a pause is stamped with the clock as it stood when that pause began, so the replay and the
    -- pace charts see a match with no dead air in it.
    case when v_started_at is null then null
         else floor(
                extract(epoch from (s.created_at - v_started_at))
                - public.paused_seconds_before(v_pauses, s.created_at)
              )::int - v_begins_at end,
    v_room.board_size,
    v_square_set,
    v_board_seed,
    v_board_perm
    from _shots s
    left join players p on p.id = s.attacker_player_id
  on conflict (match_key, nickname, cell_index) do nothing;

  return v_match_key;
end;
$$;


grant execute on function public.archive_match(uuid, text, jsonb, jsonb, jsonb) to anon, authenticated;
