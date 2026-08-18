-- ===========================================================================
--  Match durations past an hour
-- ===========================================================================
-- archive_match wrote its duration as
--
--   lpad((v_elapsed / 60)::text, 2, '0') || ':' || lpad((v_elapsed % 60)::text, 2, '0')
--
-- which reads like a harmless zero-pad but isn't: Postgres' lpad TRUNCATES (on the right) when the
-- string is already longer than the target length. Under 100 minutes nothing shows, because the
-- minute field is one or two digits anyway. At 100 minutes and up the minutes get cut to their
-- first two digits, so a two-hour match archived as '12:00' - twelve minutes - and every reader
-- downstream believed it: the Almanac, the home feed, and matchEpithet, which named a 120-minute
-- grind "The Slaughter" because it thought 143 shots had landed in twelve minutes.
--
-- The client has always formatted the live clock correctly (lib/matchTime.formatDuration: h:mm:ss
-- past an hour, mm:ss below it) and lib/matchName.durationSeconds has always parsed both shapes.
-- Only the archive disagreed, so this teaches the archive the client's format and leaves both ends
-- of the wire alone.

-- The one place the format lives now, so the archive and the backfill below cannot drift apart.
-- Mirrors formatDuration in src/lib/matchTime.ts exactly, including the clamp at zero.
create or replace function public.duration_text(p_seconds int)
returns text
language plpgsql
immutable
strict
as $$
declare
  s int := greatest(p_seconds, 0);
begin
  if s >= 3600 then
    return (s / 3600)::text || ':' || lpad(((s % 3600) / 60)::text, 2, '0') || ':' || lpad((s % 60)::text, 2, '0');
  end if;
  return lpad((s / 60)::text, 2, '0') || ':' || lpad((s % 60)::text, 2, '0');
end;
$$;

-- ===========================================================================
--  archive_match, formatting its duration through the helper
-- ===========================================================================
-- Reproduced in full for the usual reason: `create or replace function` cannot patch a body. The
-- only change against the board_balance version is the v_duration assignment.
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

  -- The room is the authority on all three: which set was played, which seed dealt the board, and
  -- how the balancer rearranged it.
  v_square_set := coalesce(v_room.square_set, 'bosses');
  v_board_seed := v_room.seed;
  v_board_perm := v_room.board_perm;

  select min(created_at) into v_started_at
    from attacks where room_id = p_room_id and cell_index = -1;

  v_match_key := v_room.code || ':' || coalesce(v_started_at::text, 'unknown');
  v_begins_at := coalesce(v_room.starting_seconds, 10) + coalesce(v_room.prep_seconds, 240);

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
    v_elapsed := greatest(0, floor(extract(epoch from (v_last_shot - v_started_at)))::int - v_begins_at);
    v_duration := public.duration_text(v_elapsed);
  end if;

  -- -- match_reports --------------------------------------------------------
  insert into match_reports (match_key, room_code, winner_team, duration, total_shots, summary, report_text, square_set)
  values (v_match_key, v_room.code, v_room.winner_team, v_duration, v_total, p_summary, p_report_text, v_square_set)
  on conflict (match_key) do nothing;

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
    coalesce((
      select count(*) from attacks a2
       where a2.room_id = p_room_id and a2.result = 'sunk' and a2.defender_team = s.attacker_team
    ), 0)::int,
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
    case when v_started_at is null then null
         else floor(extract(epoch from (s.created_at - v_started_at)))::int - v_begins_at end,
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

-- ===========================================================================
--  Repair the durations already written
-- ===========================================================================
-- A truncated '12:00' cannot be told from an honest one by looking at it, but it doesn't have to be:
-- match_events.match_seconds is the same per-shot elapsed the duration was computed from, stored as
-- an integer that no formatting ever touched. The last shot's match_seconds IS the duration, so the
-- archive can be rebuilt from it rather than guessed at.
--
-- Matches whose start marker never landed have null match_seconds throughout and are skipped, so
-- their '--:--' stands. The `is distinct from` guard means already-correct rows aren't rewritten.
update match_reports r
   set duration = public.duration_text(e.elapsed)
  from (
    select match_key, greatest(0, max(match_seconds)) as elapsed
      from match_events
     where match_seconds is not null
     group by match_key
  ) e
 where e.match_key = r.match_key
   and r.duration is distinct from public.duration_text(e.elapsed);
