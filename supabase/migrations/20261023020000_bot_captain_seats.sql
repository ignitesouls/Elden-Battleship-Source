-- The bot crew sits as its captains: one seat each ---------------------------------------------------
--
-- The bot already PLAYED as a crew (one simulated captain per person on the biggest fleet it faces -
-- see src/lib/botCrew.ts and 20261023010000_bot_crew_state.sql) but it sat as one player, so a crew of
-- three facing it saw "Sweat" fire three times as often as anybody and the recap credited him with
-- everything. Now each captain has a seat of its own on the bot's fleet - "Sweat · Limgrave",
-- "Sweat · Flex", "Sweat · DLC" - and fires under it, so the roster, the scoreboard and the recap read
-- like a real crew's.
--
-- A seat needs a user id, and players is unique on (room_id, user_id), so each captain gets its own
-- placeholder id, all sharing one prefix (BOT_CAPTAIN_IDS in src/lib/bot.ts). The first is the
-- original bot_user_id(), so every room and every check written against it keeps working.
--
-- Who seats them: the bot edge function, when placement opens - that is when fleets lock, so it is the
-- first moment the size of the biggest crew is settled. In the lobby the bot is one seat, as before.
--
-- What this migration does:
--   1. is_bot_user(): any of the bot's seats.
--   2. guard_bot_fleet: every bot seat is the bot's, and none may be moved by a browser.
--   3. set_room_bot: removing the bot or changing its tier clears every captain seat.
--   4. A room going back to the lobby folds the crew back into one seat named for the tier.

-- ===========================================================================
--  1. is_bot_user
-- ===========================================================================

create or replace function public.is_bot_user(p_user_id uuid)
returns boolean
language sql
immutable
as $$
  -- Must match BOT_CAPTAIN_IDS / isBot in src/lib/bot.ts.
  select p_user_id::text like 'b0700000-0000-4000-8000-000000000b%';
$$;

-- ===========================================================================
--  2. guard_bot_fleet, now for every seat
-- ===========================================================================
--
-- Restated from 20261022000000_bot_opponent.sql with bot_user_id() equality widened to is_bot_user().

create or replace function public.guard_bot_fleet()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.team is not distinct from old.team then
    return new;
  end if;
  if public.is_bot_user(new.user_id) then
    if tg_op = 'UPDATE' and current_user not in ('service_role', 'postgres', 'supabase_admin') then
      raise exception 'The bot keeps its fleet - remove it from the Opponent setting instead';
    end if;
    return new;
  end if;
  if new.team is null then
    return new;
  end if;
  if exists (select 1 from rooms r where r.id = new.room_id and r.bot_team = new.team) then
    raise exception 'That fleet is the bot''s - pick another colour';
  end if;
  return new;
end;
$$;

-- ===========================================================================
--  3. set_room_bot clears every captain seat
-- ===========================================================================
--
-- Restated from 20261022000000_bot_opponent.sql. Two changes: taking the bot out deletes all of its
-- seats, not just the first; and changing tier folds a crew left over from the last match back into
-- the one seat, which the edge function re-seats when placement next opens.

create or replace function public.set_room_bot(p_room_id uuid, p_tier text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room  rooms%rowtype;
  v_team  int;
  v_names jsonb;
  v_old   text;
  v_bot_names text[] := array['Chud''s Fleet', 'Tarnished''s Fleet', 'Sweat''s Fleet', 'Shaker''s Fleet'];
begin
  select * into v_room from rooms where id = p_room_id for update;
  if not found then
    raise exception 'No such room';
  end if;

  if not exists (
    select 1 from players p
     where p.room_id = p_room_id
       and p.user_id = auth.uid()
       and p.is_host
  ) then
    raise exception 'Only the host can choose an opponent';
  end if;

  if v_room.status <> 'lobby' then
    raise exception 'The opponent is chosen in the lobby - wait for this match to finish';
  end if;

  if v_room.tournament_match_id is not null then
    raise exception 'An official match is played against people, not a bot';
  end if;

  v_names := case when jsonb_typeof(v_room.team_names) = 'array' then v_room.team_names else '[]'::jsonb end;

  -- -- taking the bot out --------------------------------------------------------------------
  if p_tier is null then
    if v_room.bot_team is not null and jsonb_array_length(v_names) > v_room.bot_team then
      v_old := v_names ->> v_room.bot_team;
      if v_old = any (v_bot_names) then
        v_names := jsonb_set(v_names, array[v_room.bot_team::text], 'null'::jsonb);
      end if;
    end if;
    delete from players where room_id = p_room_id and public.is_bot_user(user_id);
    update rooms set bot_tier = null, bot_team = null, bot_next_s = null, team_names = v_names
     where id = p_room_id;
    return;
  end if;

  if p_tier not in ('chud', 'tarnished', 'sweat', 'shaker') then
    raise exception 'No such opponent: %', p_tier;
  end if;

  -- -- seating it ---------------------------------------------------------------------------
  -- Any captain seats beyond the first go; the edge function seats the crew at placement.
  delete from players
   where room_id = p_room_id and public.is_bot_user(user_id) and user_id <> public.bot_user_id();

  select p.team into v_team
    from players p
   where p.room_id = p_room_id and p.user_id = public.bot_user_id();

  if found and v_team is not null then
    update players set nickname = initcap(p_tier)
     where room_id = p_room_id and user_id = public.bot_user_id();
  else
    select min(t) into v_team
      from generate_series(0, 8) t
     where not exists (select 1 from players p where p.room_id = p_room_id and p.team = t);
    if v_team is null then
      raise exception 'Every fleet colour is taken - free one up for the bot';
    end if;

    delete from players where room_id = p_room_id and user_id = public.bot_user_id();
    insert into players (room_id, user_id, nickname, team, is_host, team_joined_at)
    values (p_room_id, public.bot_user_id(), initcap(p_tier), v_team, false, now());

    insert into fleets (room_id, team) values (p_room_id, v_team) on conflict (room_id, team) do nothing;
    perform public.reseed_fleets(p_room_id, v_team);
  end if;

  while jsonb_array_length(v_names) <= v_team loop
    v_names := v_names || 'null'::jsonb;
  end loop;
  v_old := v_names ->> v_team;
  if v_old is null or v_old = any (v_bot_names) then
    v_names := jsonb_set(v_names, array[v_team::text], to_jsonb(initcap(p_tier) || '''s Fleet'));
  end if;

  update rooms
     set bot_tier   = p_tier,
         bot_team   = v_team,
         bot_next_s = null,
         practice   = true,
         team_names = v_names
   where id = p_room_id;
end;
$$;

revoke execute on function public.set_room_bot(uuid, text) from public;
grant execute on function public.set_room_bot(uuid, text) to anon, authenticated;

-- ===========================================================================
--  4. Back in the lobby, the crew folds into one seat
-- ===========================================================================
--
-- After a match the lobby would otherwise still show "Sweat · Limgrave", "Sweat · Flex"... from the
-- game just played, and the crew for the next one may be a different size. Security definer so it can
-- remove the bot's seats whoever's browser sent the room back to the lobby.

create or replace function public.rooms_bot_back_to_lobby()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'lobby' and old.status is distinct from 'lobby' and new.bot_tier is not null then
    delete from players
     where room_id = new.id and public.is_bot_user(user_id) and user_id <> public.bot_user_id();
    update players set nickname = initcap(new.bot_tier)
     where room_id = new.id and user_id = public.bot_user_id();
  end if;
  return null;
end;
$$;

drop trigger if exists rooms_bot_back_to_lobby on rooms;
create trigger rooms_bot_back_to_lobby
  after update of status on rooms
  for each row execute function public.rooms_bot_back_to_lobby();
