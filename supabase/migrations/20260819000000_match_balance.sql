-- ===========================================================================
--  What the balancer knew, kept
-- ===========================================================================
-- The balancer already works out how lopsided a board is. `balanceBoard` returns the widest
-- same-rank gap between two fleets both before it touched the deal and after, in seconds, and
-- balance-board has been returning both to the caller since it shipped - where lib/rooms.ts read
-- `balanced` and dropped the rest on the floor.
--
-- That is why the balance-stats function has the shape it does: to answer "how
-- fair was that match" for an archived match, it re-derives the board from the seed, re-prices every
-- square and runs a fresh rejection sample - the most expensive thing in the codebase, about 400ms a
-- match, which is why it is paged three at a time and admin-gated. All to recompute a number that
-- was sitting in a variable at deal time and was thrown away.
--
-- So: keep it. `rooms.balance_report` holds what the balancer knew about the board it just dealt,
-- and archive_match copies it onto the match the way it already copies the seed and the permutation.
-- Nothing is recomputed and nothing new is spent.
--
-- -- What this does and does not publish ---------------------------------------------------------
--
-- bossTimeCost.json still never leaves the server, and no square is named here. What lands in this
-- column is a handful of scalars ABOUT a finished board: how far apart the two fleets' ship profiles
-- were, how many draws it took, and the slowest square gating each fleet's slowest ship. Those are
-- aggregates over the whole board and both fleets, and a reader already knows every square that was
-- on it - the recap draws them. Recovering per-square costs from them would mean inverting one
-- non-linear scalar per match across a 206-square table.
--
-- It is not nothing, though, and the choice is deliberate: this is the
-- first balancer number the site shows a player, and it shows it only once the match is over.
--
-- -- Why one column and not a table ---------------------------------------------------------------
--
-- One row per match either way, and match_reports already IS the one-row-per-match table - it is
-- world-readable, it is what the recap page and the Almanac's history already read, and a jsonb
-- column costs no join. A separate table would buy schema for numbers whose shape is still moving.
alter table rooms         add column if not exists balance_report jsonb;
alter table match_reports add column if not exists balance jsonb;

comment on column rooms.balance_report is
  'What the balancer knew about this board at deal time. Written by balance-board only. See archive_match.';
comment on column match_reports.balance is
  'This match''s fairness record: {v, source, dealt, played, limit, ...}, seconds. From the room at deal time, or backfilled by balance-stats.';

-- ===========================================================================
--  Only the balancer may write it
-- ===========================================================================
-- Same reasoning as board_perm, which this trigger already guards, and the same attack: "rooms
-- update by player" lets any player in a room update any column of it. A captain who could PATCH
-- balance_report could not change the board - the perm is guarded and the squares are dealt from the
-- seed - but they could write a fairness record for a board that never existed, and the recap, the
-- percentile and every other match's ranking against it would repeat the lie without question.
--
-- Clearing stays open for both columns, because resetRoomToLobby runs as the host and has to be able
-- to wipe the previous match. Only writing a value is restricted.
--
-- Still deliberately NOT `security definer`: inside one, `current_user` is the function's owner and
-- the role check below would pass for every caller alive. See the board_balance migration.
create or replace function public.guard_board_perm()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Every guarded column is either untouched by this update or being cleared. One condition rather
  -- than two passes, so adding a third column later is one more line and not one more branch.
  if (new.board_perm is not distinct from old.board_perm or new.board_perm is null)
     and (new.balance_report is not distinct from old.balance_report or new.balance_report is null) then
    return new;
  end if;

  -- PostgREST switches to the service_role database role for service-key requests, which is what the
  -- edge function uses; postgres/supabase_admin cover the SQL editor and any later migration.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  raise exception 'Board layouts are dealt by the balancer, not by players';
end;
$$;

-- ===========================================================================
--  archive_match, stamping the balance record as well
-- ===========================================================================
-- Reproduced in full for the usual reason: `create or replace function` cannot patch a body. The
-- only change against the duration_past_an_hour version is v_balance and the one extra column on
-- the match_reports insert.
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
--  Reading it back
-- ===========================================================================
-- match_reports is already world-readable (`select using (true)`), which is what makes a permanent
-- linkable recap possible at all, so the new column needs no policy of its own. Writing it is closed
-- to clients along with every other column of that table - see lock_down_writes - which leaves
-- archive_match (security definer, above) and the balance-stats function (service role) as the only
-- two writers. That is the intended pair: one for matches as they finish, one to backfill the
-- archive that finished before this existed.
