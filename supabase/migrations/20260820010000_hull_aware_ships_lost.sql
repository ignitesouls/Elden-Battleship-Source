-- Ships lost, counted in HULLS rather than in sunk reports.
--
-- `team_ships_lost` was `count(*)` over every 'sunk' row against a team, which assumes one row per
-- hull. That is not true and has not been since idempotent shot resolution landed: a second shot at
-- a square another crew already settled copies the first verdict wholesale, geometry included (see
-- 20260803_idempotent_shot_resolution), so one hull can leave two 'sunk' rows behind. Every extra
-- row was counted as another ship on the bottom.
--
-- It shows up in the archive as a fleet that lost more ships than it ever had. Two matches in the
-- live records say so outright - a seven-hull fleet recorded as losing eight, a five-hull fleet as
-- losing six - and the same defect quietly inflates the rows that stayed inside the fleet size,
-- where nothing looks wrong. It feeds "Ships lost" on the leaderboard and on every captain's page,
-- and "Flawless wins" on the almanac.
--
-- The fix is the one the client already uses for the same question (lib/battleshipLogic's
-- sunkHullFlags): identify a hull by WHERE IT WAS, not by how many reports mention it. A start cell
-- names a hull exactly, because validatePlacements() forbids two ships sharing a square.
--
-- Deliberately NOT changed here: `sunk`, the ships each PLAYER is credited with sinking, has the
-- same double-report flaw. Fixing it means deciding which of two crews owns a kill they both have a
-- row for, and that is an attribution question rather than a counting one. Left alone until it is
-- answered on purpose.

-- -- 1. the counter ---------------------------------------------------------

-- Hulls of `p_team` confirmed sunk in this room, from the live attack log.
--
-- Rows carrying geometry are counted once per distinct start cell, which de-duplicates repeat
-- reports for free. Rows without it are counted individually: resolve_attack() only records the
-- geometry when the fleet had placements to read, so a row from before that column existed has
-- nothing to key on and is taken at face value. The two cannot be mixed within one team - whether
-- the geometry is written turns on that fleet's own placements - so no hull is counted both ways.
create or replace function public.hulls_sunk(p_room_id uuid, p_team int)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select (
    (select count(distinct (a.sunk_start_row, a.sunk_start_col))
       from attacks a
      where a.room_id = p_room_id
        and a.result = 'sunk'
        and a.defender_team = p_team
        and a.sunk_start_row is not null
        and a.sunk_start_col is not null)
    +
    (select count(*)
       from attacks a
      where a.room_id = p_room_id
        and a.result = 'sunk'
        and a.defender_team = p_team
        and (a.sunk_start_row is null or a.sunk_start_col is null))
  )::int;
$$;

grant execute on function public.hulls_sunk(uuid, int) to anon, authenticated;

-- -- 2. archive_match, with that counter in place of the row count -----------

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
  insert into match_reports (match_key, room_code, winner_team, duration, total_shots, summary, report_text, square_set, balance)
  values (v_match_key, v_room.code, v_room.winner_team, v_duration, v_total, p_summary, p_report_text, v_square_set, v_balance)
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

-- -- 3. the rows already written -------------------------------------------

-- The same count, rebuilt from the ARCHIVE rather than from the live attack log.
--
-- The rows this has to correct belong to matches whose `attacks` were deleted the moment the room
-- reset for the next game, so hulls_sunk() above has nothing to look at. What survives is enough:
-- match_fleets keeps every fleet's placements and ship_defs, and match_events keeps every square
-- that was fired at and who fired it. A hull is down when every one of its cells was fired at by
-- somebody on another team - which is exactly how lib/replay.ts redraws these matches on the recap
-- page, so the recap and the record now derive it the same way.
--
-- Returns null, not 0, when the fleet has no placements archived. A match from before match_fleets
-- carried them cannot be recomputed, and "no ships lost" is a claim the data does not support.
create or replace function public.hulls_sunk_archived(p_match_key text, p_team int)
returns int
language sql
stable
security definer
set search_path = public
as $$
  with fleet as (
    select f.board_size, f.placements, f.ship_defs
      from match_fleets f
     where f.match_key = p_match_key and f.team = p_team
     limit 1
  ),
  struck as (
    select distinct e.cell_index
      from match_events e
     where e.match_key = p_match_key
       and e.team <> p_team
       and e.cell_index >= 0
  ),
  hulls as (
    select (p.value ->> 'startRow')::int                                    as start_row,
           (p.value ->> 'startCol')::int                                    as start_col,
           coalesce((p.value ->> 'isHorizontal')::boolean, false)           as horiz,
           (f.ship_defs -> ((p.value ->> 'shipIndex')::int) ->> 'size')::int as size,
           f.board_size
      from fleet f, jsonb_array_elements(f.placements) p
     where jsonb_typeof(f.placements) = 'array'
  )
  select case
           when not exists (select 1 from hulls) then null
           else (
             select count(*)::int from hulls h
              where h.size is not null
                and not exists (
                  select 1 from generate_series(0, h.size - 1) i
                   where (case when h.horiz then h.start_row else h.start_row + i end) * h.board_size
                       + (case when h.horiz then h.start_col + i else h.start_col end)
                         not in (select cell_index from struck)
                )
           )
         end;
$$;

grant execute on function public.hulls_sunk_archived(text, int) to anon, authenticated;

-- Correct the records, in the one direction the defect can have moved them.
--
-- Only ever LOWERS a stored number. Every failure mode here is an over-count - a hull reported sunk
-- twice - so a recomputation that comes out higher than what was stored is evidence that the
-- rebuild is missing something, not that the record was too generous. Refusing to raise means the
-- worst this can do on a match it has misread is leave the row exactly as it found it.
--
-- Rows whose fleet was never archived are skipped by the null: `<` is unknown against null, so they
-- match nothing and keep the number they have.
update match_participants mp
   set team_ships_lost = public.hulls_sunk_archived(mp.match_key, mp.team)
 where public.hulls_sunk_archived(mp.match_key, mp.team) < mp.team_ships_lost;
