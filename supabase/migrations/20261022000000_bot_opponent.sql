-- Bot opponents: a practice fleet that plays itself ------------------------------------------------
--
-- A player's idea: a crew (or a solo captain) who wants a match and has nobody to play. The host
-- picks an opponent in the lobby - Chud, Tarnished, Sweat or Shaker, weakest to strongest - and the
-- bot takes a fleet of its own. See src/lib/bot.ts for the tiers and src/lib/botBrain.ts for how
-- each one plays.
--
-- -- Why the bot is a players row ------------------------------------------------------------------
--
-- Everything in a match is keyed on teams-with-players: activeTeams() on every client, the survivor
-- count in resolve_attack, the fleet check before a battle starts, archive_match's participants.
-- A bot that was anything other than a player on a team would have to be taught to every one of
-- them. As a row it is already on the roster, already counted, already in the recap.
--
-- Its user id is a fixed constant (bot_user_id below) that is no account at all. No browser can
-- claim it: the players insert policy is user_id = auth.uid(), and nobody's uid is this. Only the
-- security definer function here writes it.
--
-- -- Who moves the bot ----------------------------------------------------------------------------
--
-- The `bot` edge function: it places the bot's ships when placement opens and fires its shots
-- during the match, over a direct database connection like auto-fire's. A browser in the room only
-- tells it when it is due - bot_next_s, below - and the function checks the clock itself, so
-- calling early, twice, or from two tabs does nothing.
--
-- -- What this migration does ---------------------------------------------------------------------
--
--   1. rooms.bot_tier / bot_team / bot_next_s, server-written only.
--   2. set_room_bot(): the host's lobby control. Seats the bot, names its fleet, makes the match
--      practice. Null takes the bot back out.
--   3. A bot room is always practice, and no person can join the bot's fleet.
--   4. Kicking the bot is the same as removing it.
--   5. guard_fleet_placement lets the server place the bot's ships. It used to require the fleet's
--      own captain to be the one signed in, and the bot's captain is the bot.

-- ===========================================================================
--  1. Columns
-- ===========================================================================

alter table public.rooms
  add column if not exists bot_tier text check (bot_tier in ('chud', 'tarnished', 'sweat', 'shaker'));
alter table public.rooms add column if not exists bot_team int;
alter table public.rooms add column if not exists bot_next_s int;

comment on column public.rooms.bot_tier is
  'The bot opponent in this room, or null for none. Set only through set_room_bot(), in the lobby.';
comment on column public.rooms.bot_team is
  'Which fleet the bot sits on. Null whenever bot_tier is.';
comment on column public.rooms.bot_next_s is
  'Match seconds (pauses excluded, counted from firing opening) at which the bot next fires. Written by the bot edge function; cleared whenever the room returns to lobby or placement.';

create or replace function public.bot_user_id()
returns uuid
language sql
immutable
as $$
  -- Must match BOT_USER_ID in src/lib/bot.ts.
  select 'b0700000-0000-4000-8000-000000000b07'::uuid;
$$;

-- ===========================================================================
--  2. set_room_bot
-- ===========================================================================

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
      -- Only the name the bot was given. A host who renamed the fleet themselves keeps their name.
      if v_old = any (v_bot_names) then
        v_names := jsonb_set(v_names, array[v_room.bot_team::text], 'null'::jsonb);
      end if;
    end if;
    -- Clears the room's bot columns through players_bot_removed below. Practice is left on: the
    -- host may well want a practice match against people next, and turning it off is one click.
    delete from players where room_id = p_room_id and user_id = public.bot_user_id();
    update rooms set bot_tier = null, bot_team = null, bot_next_s = null, team_names = v_names
     where id = p_room_id;
    return;
  end if;

  if p_tier not in ('chud', 'tarnished', 'sweat', 'shaker') then
    raise exception 'No such opponent: %', p_tier;
  end if;

  -- -- seating it ---------------------------------------------------------------------------
  select p.team into v_team
    from players p
   where p.room_id = p_room_id and p.user_id = public.bot_user_id();

  if found and v_team is not null then
    update players set nickname = initcap(p_tier)
     where room_id = p_room_id and user_id = public.bot_user_id();
  else
    -- The first colour nobody is on. Nine is the palette (TEAM_COLORS).
    select min(t) into v_team
      from generate_series(0, 8) t
     where not exists (select 1 from players p where p.room_id = p_room_id and p.team = t);
    if v_team is null then
      raise exception 'Every fleet colour is taken - free one up for the bot';
    end if;

    delete from players where room_id = p_room_id and user_id = public.bot_user_id();
    insert into players (room_id, user_id, nickname, team, is_host, team_joined_at)
    values (p_room_id, public.bot_user_id(), initcap(p_tier), v_team, false, now());

    -- The fleet row a person's browser makes with ensureFleet() when they pick a colour, shaped
    -- for this board. The bot has no browser.
    insert into fleets (room_id, team) values (p_room_id, v_team) on conflict (room_id, team) do nothing;
    perform public.reseed_fleets(p_room_id, v_team);
  end if;

  -- Its fleet is named for it, unless the host has already named that fleet something else.
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

comment on function public.set_room_bot(uuid, text) is
  'Host only, lobby only, never on an official match: seats a bot opponent (chud, tarnished, sweat or shaker) on the first free fleet and makes the match practice. Null removes it.';

-- ===========================================================================
--  3. Always practice, and the bot's fleet is the bot's
-- ===========================================================================

create or replace function public.guard_room_bot()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin')
     and (new.bot_tier is distinct from old.bot_tier
          or new.bot_team is distinct from old.bot_team
          or new.bot_next_s is distinct from old.bot_next_s)
  then
    raise exception 'The opponent is chosen with the lobby''s Opponent setting';
  end if;

  -- The point of the whole feature being safe to ship: nothing a bot plays can ever count.
  if new.bot_tier is not null and not coalesce(new.practice, false) then
    raise exception 'A match against a bot is always practice - remove the bot to play one that counts';
  end if;

  -- A new match, a new clock. The bot function sets the first shot once firing opens.
  if new.status is distinct from old.status and new.status in ('lobby', 'placement') then
    new.bot_next_s := null;
  end if;

  return new;
end;
$$;

drop trigger if exists rooms_guard_bot on rooms;
create trigger rooms_guard_bot
  before update on rooms
  for each row execute function public.guard_room_bot();

create or replace function public.guard_bot_fleet()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.team is not distinct from old.team then
    return new;
  end if;
  -- The host may rename the bot (players update by host) but not move it: bot_team would then name
  -- a fleet it no longer sits on. Only set_room_bot seats it.
  if new.user_id = public.bot_user_id() then
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

drop trigger if exists players_guard_bot_fleet on players;
create trigger players_guard_bot_fleet
  before insert or update of team on players
  for each row execute function public.guard_bot_fleet();

-- ===========================================================================
--  4. Kicking the bot removes it
-- ===========================================================================

-- Security definer so the room write passes guard_room_bot: the delete itself came from the host's
-- browser, which may not touch the bot columns directly.
create or replace function public.players_bot_removed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id = public.bot_user_id() then
    update rooms set bot_tier = null, bot_team = null, bot_next_s = null
     where id = old.room_id and bot_team is not distinct from old.team;
  end if;
  return old;
end;
$$;

drop trigger if exists players_bot_removed on players;
create trigger players_bot_removed
  after delete on players
  for each row execute function public.players_bot_removed();

-- ===========================================================================
--  5. guard_fleet_placement, now letting the server place the bot's ships
-- ===========================================================================
--
-- Unchanged from 20260727010000_fleet_captains.sql except for the session_user line. That function
-- is security definer, so current_user inside it is always its owner and cannot tell a browser from
-- the server; session_user can. A browser arrives through PostgREST as `authenticator`; the bot
-- function connects straight to the database as `postgres`, the way auto-fire does.

create or replace function public.guard_fleet_placement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if session_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  if (new.placements is distinct from old.placements
      or new.placement_confirmed is distinct from old.placement_confirmed)
     and exists (select 1 from rooms r where r.id = new.room_id and r.status = 'placement')
     and not public.is_admin()
     and not exists (
       select 1 from players p
        where p.id = public.team_captain(new.room_id, new.team)
          and p.user_id = auth.uid()
     )
  then
    raise exception 'Only the fleet captain places this team''s ships';
  end if;

  return new;
end;
$$;
