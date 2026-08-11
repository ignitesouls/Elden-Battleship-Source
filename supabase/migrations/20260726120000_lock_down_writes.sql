-- Closes three ways an ordinary visitor could vandalise the site, and gives admins the tools the
-- previous migration implied but didn't actually provide.
--
-- All three were verified against the live database with a second anonymous session standing in
-- for a stranger. None of them needed anything beyond the anon key, which ships in the JS bundle.

-- ===========================================================================
--  1. Attacks: only the host may clear a match's log
-- ===========================================================================
-- Was `for delete using (true)`. A stranger holding a room code could delete every attack row in
-- a live match: not just the hit/miss markers, but the cell_index = -1 start marker, which is the
-- anchor the match clock is measured from. Both boards blank mid-battle and the timer dies.
--
-- The policy existed because resetRoomToLobby() has to clear the log between matches - and that
-- is only ever triggered by the host, from "End match" or "Play again".
drop policy if exists "attacks delete" on attacks;
create policy "attacks delete by host" on attacks for delete using (
  exists (
    select 1 from players p
     where p.room_id = attacks.room_id
       and p.user_id = auth.uid()
       and p.is_host
  )
  or public.is_admin()
);

-- ===========================================================================
--  2. Rooms: only people actually in the room may change it
-- ===========================================================================
-- Was `for update using (true)`, unchanged since the initial schema. Anyone who knew a room code
-- could end a live match, set a fake winner, rename the teams, or resize the board.
--
-- Scoped to any player in the room rather than to the host, because legitimate writes come from
-- both: the host starts placement and resets the room, but the match-end detection in useRoom
-- runs on EVERY client, and whichever one notices first writes status='finished'.
drop policy if exists "rooms update" on rooms;
create policy "rooms update by player" on rooms for update using (
  exists (
    select 1 from players p
     where p.room_id = rooms.id
       and p.user_id = auth.uid()
  )
  or public.is_admin()
);

-- ===========================================================================
--  3. The record books: derived on the server, not posted by the client
-- ===========================================================================
-- match_reports and match_participants were `for insert with check (true)`, so anyone could POST
-- arbitrary career stats under any nickname AND attribute them to any user_id - nothing compared
-- it to auth.uid(). The whole leaderboard was writable fiction.
--
-- It can't be fixed by tightening the policy alone, because the legitimate writes also come from
-- players' browsers when a match ends. So the numbers move to the server: this function derives
-- every figure that feeds a ranking from the room's own `attacks` and `players` rows.
--
-- The client still supplies the things the server genuinely cannot know - the boss names (drawn
-- from a seeded shuffle that lives in TypeScript), the report text, and the award titles. Those
-- are cosmetic: forging them changes flavour text, not a leaderboard position.
create or replace function public.archive_match(
  p_room_id     uuid,
  p_report_text text  default '',
  p_summary     jsonb default '{}'::jsonb,
  -- { "nickname": ["Award title", ...] }
  p_awards      jsonb default '{}'::jsonb,
  -- ["Boss name", ...] indexed by cell, so match_events can be read back by name later.
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
begin
  select * into v_room from rooms where id = p_room_id;
  if not found then
    raise exception 'No such room';
  end if;

  -- You must have actually been in the match you're filing a report for. This alone kills
  -- forgery from nowhere; everything below makes the numbers themselves unforgeable too.
  if not public.is_admin()
     and not exists (
       select 1 from players p where p.room_id = p_room_id and p.user_id = auth.uid()
     )
  then
    raise exception 'Only players in this room can archive it';
  end if;

  -- cell_index = -1 is the match-start marker (MATCH_START_MARKER in lib/matchTime.ts).
  select min(created_at) into v_started_at
    from attacks where room_id = p_room_id and cell_index = -1;

  -- Server-generated so it's identical for every client that calls this, which is what makes the
  -- unique constraints below collapse concurrent archive attempts into one set of rows.
  v_match_key := v_room.code || ':' || coalesce(v_started_at::text, 'unknown');

  v_begins_at := coalesce(v_room.starting_seconds, 10) + coalesce(v_room.prep_seconds, 240);

  -- One shot writes one attack row per opposing team, so a "shot" is the group, not the row.
  -- Matches groupIntoShots(): keyed on attacker, square, and timestamp.
  --
  -- Built with CREATE TABLE AS rather than create-then-truncate. Supabase runs pg_safeupdate,
  -- which rejects any DELETE without a WHERE clause - including `delete from _shots;` against a
  -- temp table inside a SECURITY DEFINER function, because the session setting is inherited. That
  -- aborted the whole call, so every match silently failed to archive.
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

  -- Nothing happened; not worth a row. Mirrors the client's old `totalShots === 0` guard.
  if v_total = 0 then
    return null;
  end if;

  if v_started_at is null then
    v_duration := '--:--';
  else
    v_elapsed := greatest(0, floor(extract(epoch from (v_last_shot - v_started_at)))::int - v_begins_at);
    -- Built by hand rather than to_char(interval, 'MI:SS'), which wraps at 60 minutes and would
    -- render a 65-minute match as 05:xx. Minutes are deliberately unbounded.
    v_duration := lpad((v_elapsed / 60)::text, 2, '0') || ':' || lpad((v_elapsed % 60)::text, 2, '0');
  end if;

  -- -- match_reports --------------------------------------------------------
  insert into match_reports (match_key, room_code, winner_team, duration, total_shots, summary, report_text)
  values (v_match_key, v_room.code, v_room.winner_team, v_duration, v_total, p_summary, p_report_text)
  on conflict (match_key) do nothing;

  -- -- match_participants ---------------------------------------------------
  -- hits counts SHOTS THAT CONNECTED (a shot lands on every opponent at once, so it's one hit
  -- however many boards it struck), while sunk counts every ship that shot actually put under.
  -- Same semantics as buildMatchReport, so the archived numbers match what players saw on screen.
  insert into match_participants (
    match_key, user_id, nickname, team, won, draw,
    shots, hits, misses, sunk, team_ships_lost, awards, room_code
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
    v_room.code
    from _shots s
    left join players p on p.id = s.attacker_player_id
   group by p.user_id, p.nickname, s.attacker_team
  on conflict (match_key, nickname, team) do nothing;

  -- -- match_fleets ---------------------------------------------------------
  -- Read directly rather than accepted from the caller: a client can only see its own team's
  -- placements, so a client-supplied version was always partial.
  insert into match_fleets (match_key, team, board_size, room_id, placements, ship_defs)
  select v_match_key, f.team, v_room.board_size, v_room.id,
         coalesce(f.placements, '[]'::jsonb), v_room.ship_defs
    from fleets f
   where f.room_id = p_room_id
  on conflict (match_key, team) do nothing;

  -- -- match_events ---------------------------------------------------------
  insert into match_events (
    match_key, user_id, nickname, team, cell_index, room_id,
    challenge_name, result, match_seconds, board_size
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
    v_room.board_size
    from _shots s
    left join players p on p.id = s.attacker_player_id
  on conflict (match_key, nickname, cell_index) do nothing;

  return v_match_key;
end;
$$;

grant execute on function public.archive_match(uuid, text, jsonb, jsonb, jsonb) to anon, authenticated;

-- With the function in place, direct inserts are no longer needed by anything legitimate.
-- SECURITY DEFINER means archive_match() bypasses RLS, so removing these closes the door on
-- hand-crafted records without closing it on real ones.
drop policy if exists "match_reports insert" on match_reports;
drop policy if exists "match_participants insert" on match_participants;
drop policy if exists "match_fleets insert" on match_fleets;
drop policy if exists "match_events insert" on match_events;

-- ===========================================================================
--  4. Admin moderation
-- ===========================================================================
-- Admins could delete whole rooms but not touch anybody inside one unless they happened to be
-- its host - so an offensive nickname on stream had no remedy short of deleting the match.
drop policy if exists "players update by admin" on players;
create policy "players update by admin" on players for update using (public.is_admin());

drop policy if exists "players delete by admin" on players;
create policy "players delete by admin" on players for delete using (public.is_admin());

-- prune_stale_rooms() is `revoke all from public`, so nothing could trigger a sweep on demand -
-- rooms only cleared when somebody happened to create a new one. This lets an admin ask for it.
create or replace function public.admin_prune_rooms()
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  return public.prune_stale_rooms();
end;
$$;

grant execute on function public.admin_prune_rooms() to anon, authenticated;
