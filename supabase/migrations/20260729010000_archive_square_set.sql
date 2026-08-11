-- Records which square set a finished match was played on, so the record books can be read apart.
--
-- A boss board and an objectives board are barely the same game: one is 100 kills at a pace of a
-- few minutes each, the other is "acquire 3 painting rewards". Ranking them in one table makes both
-- meaningless - a player's accuracy on objectives says nothing about their accuracy on bosses - so
-- the Leaderboard and Almanac now show one set at a time and need to know which each row belongs to.
--
-- The value is read off the ROOM inside archive_match rather than accepted from the caller. Same
-- reasoning as every other number in that function: the anon key ships in the bundle, and a column
-- the client can set is a column anyone can set. It is also why this needs no client change.
--
-- Null means 'bosses': every row written before this migration was a boss board, because that was
-- the only kind there was.

alter table match_participants add column if not exists square_set text;
alter table match_events       add column if not exists square_set text;
alter table match_fleets       add column if not exists square_set text;
alter table match_reports      add column if not exists square_set text;

create index if not exists match_participants_set_idx on match_participants (square_set);
create index if not exists match_events_set_idx       on match_events (square_set);

-- ===========================================================================
--  archive_match, unchanged except that every insert now stamps the set
-- ===========================================================================
-- Reproduced in full because `create or replace function` has no way to patch a body. The only
-- edits against the lock_down_writes version are the four `v_square_set` columns; everything else -
-- the membership check, the shot grouping, the hand-built duration, the temp table built with
-- CREATE TABLE AS to dodge pg_safeupdate - is exactly as it was and is explained there.
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

  -- The room is the authority on which set was played. Defaulted here rather than left null so
  -- every row written from now on states it outright.
  v_square_set := coalesce(v_room.square_set, 'bosses');

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
    v_duration := lpad((v_elapsed / 60)::text, 2, '0') || ':' || lpad((v_elapsed % 60)::text, 2, '0');
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
    challenge_name, result, match_seconds, board_size, square_set
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
    v_square_set
    from _shots s
    left join players p on p.id = s.attacker_player_id
  on conflict (match_key, nickname, cell_index) do nothing;

  return v_match_key;
end;
$$;

grant execute on function public.archive_match(uuid, text, jsonb, jsonb, jsonb) to anon, authenticated;
