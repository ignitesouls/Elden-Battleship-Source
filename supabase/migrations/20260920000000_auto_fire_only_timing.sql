-- Bosses-after-bosses timing must come only from auto-fire, not from a manual click -----------------
--
-- "Quickest squares on record" (Almanac) times the gap between a captain's consecutive squares. Under
-- the fire-on-kill rule a shot's timestamp is SUPPOSED to be the kill time - see the auto-fire edge
-- function's MAX_BACKDATE_MS comment. That is true for a kill the mod reports, but a manually-clicked
-- square carries whatever moment the player happened to click, which can trail the real kill by
-- however long they feel like. Mixing the two made every "after X" entry fake: sometimes the number
-- was a fight, and sometimes it was a fight plus however long somebody took to alt-tab and click.
--
-- `auto` marks a shot as fired by the auto-fire edge function rather than a manual click. Defaults to
-- false so every archived shot from before this column existed - which cannot be told apart after the
-- fact - reads as manual and drops out of the timing boards instead of continuing to skew them.

alter table attacks add column if not exists auto boolean not null default false;
alter table match_events add column if not exists auto boolean not null default false;

-- ===========================================================================
--  archive_match, now carrying `auto` from attacks onto match_events
-- ===========================================================================
-- Reproduced in full for the usual reason: `create or replace function` cannot patch a body. The
-- only change against the practice_matches version is `auto`, aggregated in _shots and carried onto
-- the match_events insert.
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
         count(*) filter (where a.result = 'sunk')::int       as sunk_count,
         -- Every row a single trigger-pull writes (one per opposing fleet) is inserted together by
         -- the same caller, so they always agree on this - bool_and vs bool_or is a formality.
         bool_and(a.auto)                                    as auto
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
    challenge_name, result, match_seconds, board_size, square_set, board_seed, board_perm, auto
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
    v_board_perm,
    s.auto
    from _shots s
    left join players p on p.id = s.attacker_player_id
  on conflict (match_key, nickname, cell_index) do nothing;

  return v_match_key;
end;
$$;

grant execute on function public.archive_match(uuid, text, jsonb, jsonb, jsonb) to anon, authenticated;
