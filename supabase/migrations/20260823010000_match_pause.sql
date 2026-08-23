-- ===========================================================================
--  Pausing a match
-- ===========================================================================
-- Real matches stop. Somebody's controller dies, somebody has to answer the door, a boss fight goes
-- wrong in a way that needs sorting out. Until now the only clock the room had was wall time since
-- the start marker (lib/matchTime.ts), which cannot stop - so a fifteen-minute break was simply
-- fifteen minutes of match time nobody played, recorded as if they had.
--
-- The house rule the pause is built around is "finish your fight, then quit out": a pause is CALLED
-- rather than imposed, and shots keep landing right through it. That is deliberate, and it is why
-- nothing here touches the attack policies. A crew mid-boss when the pause is called must be able to
-- finish - the fire-on-kill rule means their shot IS the kill time, and a blocked insert would either
-- lose the kill or force them to hold a corpse until the room came back. So the pause stops the
-- CLOCK and asks people to reach a stopping point; it does not stop the game.
--
-- -- What is stored ---------------------------------------------------------------------------------
--
-- Three columns, and between them they describe one in-flight pause plus every finished one:
--
--   pause_at    the instant the clock freezes. Set five seconds INTO THE FUTURE when the host presses
--               pause, which is the warning window - the clock is still running while it counts down.
--   resume_at   the instant the clock restarts, likewise set five seconds ahead when the host presses
--               resume. The clock stays frozen at pause_at until it arrives.
--   pause_log   every window that has already closed, as [{"at": ..., "until": ...}].
--
-- Both countdowns are timestamps rather than a status flag and a client-side timer because the
-- countdown has to read the same on six machines at once. Every client computes its own state from
-- these three values and the shared server clock (lib/serverTime), so nobody has to be told when a
-- countdown ends - which also means a host whose browser dies mid-countdown cannot strand the room:
-- the window closes on schedule everywhere, and the next host write tidies it into the log.
--
-- The log is kept - rather than one running total - because a shot's match time has to be correct,
-- not just the final duration. A shot fired after the third pause is late by the sum of the three
-- windows that closed before it, and that is only recoverable if each window is written down.

alter table rooms add column if not exists pause_at   timestamptz;
alter table rooms add column if not exists resume_at  timestamptz;
alter table rooms add column if not exists pause_log  jsonb not null default '[]'::jsonb;

-- Per-player, on the row each player already owns and every client is already subscribed to.
--
-- Both could have been a Realtime broadcast (lib/overlayCast.ts is one) and neither is, for the same
-- reason: broadcast is ephemeral. A request sent while the host is tabbed out is a request nobody
-- ever sees, and a ready flag that evaporates on a refresh means one reload sends the room back to
-- waiting on somebody who is standing right there. These survive both.
alter table players add column if not exists pause_requested_at timestamptz;
alter table players add column if not exists pause_ready        boolean not null default false;

-- ===========================================================================
--  Only the host stops the clock
-- ===========================================================================
-- "rooms update by crew" (spectators_cannot_disrupt) admits anyone holding a fleet, which is right
-- for the writes it was drawn around - the match-end detection in useRoom runs on every client. It
-- is not right for this one. Room codes are published on the front page now, so "on a fleet" is a
-- room full of people who mostly met ten minutes ago, and freezing the clock mid-fight is not a
-- thing any of them should be able to do to the other five.
--
-- A trigger rather than a policy, for the reason guard_player_team spells out: RLS cannot compare
-- the old row to the new one, so it cannot say "this column did not change" - and every other write
-- to `rooms` has to keep working untouched. Invoker rather than SECURITY DEFINER, likewise: inside a
-- definer function current_user is the owner and the admin check below would pass for everybody.
create or replace function public.guard_room_pause()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.pause_at   is not distinct from old.pause_at
     and new.resume_at is not distinct from old.resume_at
     and new.pause_log is not distinct from old.pause_log
  then
    return new;
  end if;

  -- The SQL editor, a later migration, and the edge functions' service key.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  if exists (
    select 1 from players p
     where p.room_id = new.id
       and p.user_id = auth.uid()
       and p.is_host
  ) then
    return new;
  end if;

  raise exception 'Only the host can pause or resume the match';
end;
$$;

drop trigger if exists rooms_guard_pause on rooms;
create trigger rooms_guard_pause
  before update on rooms
  for each row execute function public.guard_room_pause();

-- ===========================================================================
--  How much of the clock was stopped, as of some instant
-- ===========================================================================
-- The one piece of arithmetic the archive and the browser both need, so that a duration on the recap
-- and a duration in the record book cannot disagree. Mirrors pausedMsBefore in lib/matchPause.ts.
--
-- Windows are clamped to p_at rather than counted whole: a shot fired DURING a pause (which the
-- house rule expressly allows - finish your fight) is late by the part of the window that had
-- already passed when it landed, not by the whole of it.
create or replace function public.paused_seconds_before(p_log jsonb, p_at timestamptz)
returns double precision
language sql
stable
as $$
  select coalesce(sum(
           greatest(0, extract(epoch from (
             least((w ->> 'until')::timestamptz, p_at) - (w ->> 'at')::timestamptz
           )))
         ), 0)
    from jsonb_array_elements(coalesce(p_log, '[]'::jsonb)) w;
$$;

grant execute on function public.paused_seconds_before(jsonb, timestamptz) to anon, authenticated;

-- ===========================================================================
--  archive_match, discounting the time the clock was stopped
-- ===========================================================================
-- Reproduced in full for the usual reason: `create or replace function` cannot patch a body. The
-- only changes against the hull_aware_ships_lost version are the pause window list and the two
-- places a time is measured from the start marker - the match duration, and each shot's
-- match_seconds.
--
-- This is the half of the feature that makes a pause honest. Without it a room can stop its own
-- clock on screen and still file a two-hour record for a ninety-minute match, which is worse than
-- having no pause at all: the live clock would be telling the truth and the record book would not.
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
