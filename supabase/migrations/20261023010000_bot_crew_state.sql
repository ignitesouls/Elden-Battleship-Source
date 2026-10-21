-- The bot plays as a crew: where each of its captains is in their run ------------------------------
--
-- On the boss board the bot is now one simulated captain per person on the biggest fleet it faces,
-- each playing a run of their own - their own kills, their own DLC entry, the square they are on the
-- way to and when they will get there. See src/lib/botCrew.ts. That cannot be re-derived from the
-- attack log (an off-board gate kill leaves no shot), so it is kept here, written by the bot edge
-- function alongside bot_next_s in the same compare-and-set.
--
-- guard_room_bot is restated from 20261022000000_bot_opponent.sql with bot_state added to the
-- server-only columns and to what a new match clears. Nothing else in it changes.

alter table public.rooms add column if not exists bot_state jsonb;

comment on column public.rooms.bot_state is
  'The bot crew''s captains mid-match (src/lib/botCrew.ts CrewState). Written by the bot edge function; cleared whenever the room returns to lobby or placement.';

create or replace function public.guard_room_bot()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin')
     and (new.bot_tier is distinct from old.bot_tier
          or new.bot_team is distinct from old.bot_team
          or new.bot_next_s is distinct from old.bot_next_s
          or new.bot_state is distinct from old.bot_state)
  then
    raise exception 'The opponent is chosen with the lobby''s Opponent setting';
  end if;

  if new.bot_tier is not null and not coalesce(new.practice, false) then
    raise exception 'A match against a bot is always practice - remove the bot to play one that counts';
  end if;

  if new.status is distinct from old.status and new.status in ('lobby', 'placement') then
    new.bot_next_s := null;
    new.bot_state := null;
  end if;

  return new;
end;
$$;
