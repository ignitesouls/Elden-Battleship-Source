-- Balanced boards: where the squares actually ended up, once both fleets were down.
--
-- Every team fires at the SAME named grid, so the whole competitive asymmetry of a match is which
-- bosses happen to sit on which fleet's cells. A fleet parked on late-game bosses survives far
-- longer than one parked on tutorial soldiers, and until now that was decided by a shuffle seeded
-- before anyone had placed a ship - unseeable, uninfluenceable, and frequently lopsided.
--
-- So the deal is now finished after placement rather than before it. The balance-board edge function
-- reads every fleet, permutes the squares until each fleet's total boss difficulty lands inside a
-- tolerance band, and writes the result here.
--
-- -- Why a permutation rather than a board -------------------------------------------------------
--
-- Boards are still never stored. board_perm[cell] is an index into the board the seed already deals,
-- so the set of squares in play remains a pure function of (room id, square set, seed) - only their
-- positions move. That keeps every downstream consumer honest: auto-fire's flag coverage, the
-- Almanac's count of squares nobody fired at, and archived-match replay all still start from the
-- seeded deal and apply this on top.
--
-- null means "unbalanced", and reproduces the old behaviour exactly. That is what every room created
-- before this migration has, what every archived match has, and what a room gets when the balancer
-- is unreachable - a poorer match, but a working one.
alter table rooms        add column if not exists board_perm jsonb;
alter table match_events add column if not exists board_perm jsonb;

-- ===========================================================================
--  Only the balancer may write it
-- ===========================================================================
-- "rooms update by player" lets any player in a room update any column of it, and host-only-ness is
-- a UI convention throughout this project. That is tolerable for `seed`, where a reroll is symmetric
-- and hurts the roller as much as anyone. It is not tolerable here: a captain who could PATCH
-- board_perm could deal tutorial bosses onto the enemy fleet and late-game ones onto their own, and
-- nothing downstream would ever question it.
--
-- Clearing it stays open, because resetRoomToLobby runs as the host and must be able to wipe the
-- previous match's layout. Only writing a layout is restricted.
--
-- Deliberately NOT `security definer`, which is the opposite of the choice every other function in
-- this schema makes and the whole reason this one works. Inside a security definer function
-- `current_user` is the function's OWNER - postgres - so the role check below would pass for every
-- caller alive and the guard would wave through exactly what it exists to stop. As an invoker
-- function it sees the role PostgREST actually switched to. It needs no elevated rights of its own:
-- it reads NEW and OLD and raises, and touches no table.
create or replace function public.guard_board_perm()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.board_perm is not distinct from old.board_perm then
    return new;
  end if;
  if new.board_perm is null then
    return new;
  end if;

  -- PostgREST switches to the service_role database role for service-key requests, which is what
  -- the edge function uses; postgres/supabase_admin cover the SQL editor and any later migration.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  raise exception 'Board layouts are dealt by the balancer, not by players';
end;
$$;

drop trigger if exists rooms_guard_board_perm on rooms;
create trigger rooms_guard_board_perm
  before update on rooms
  for each row execute function public.guard_board_perm();

-- ===========================================================================
--  archive_match, now stamping the permutation as well as the seed
-- ===========================================================================
-- Same reasoning as the board_seed migration, and the same reason it is reproduced in full:
-- `create or replace function` cannot patch a body. The Almanac reconstructs a finished board to
-- count the squares nobody fired at, and on a balanced match the seed alone no longer says where
-- anything was. The only change against the archive_board_seed version is v_board_perm and the one
-- extra column on the match_events insert.
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
