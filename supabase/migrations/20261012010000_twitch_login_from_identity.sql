-- Twitch accounts with no twitch_login, and so no way to be invited to a team.
--
-- Invitations, the invite inbox and an admin adding a player by name all match on
-- profiles.twitch_login. It is written by the twitch-login edge function, and the watch_handles
-- migration backfilled it from user_metadata->>'twitch_login', which that function also writes.
--
-- Accounts from the first days (late July 2026) signed in through Supabase's own Twitch provider,
-- before that function existed. A session refreshes itself indefinitely, so some of those players have
-- never been through the function since: their profile has a twitch_id (the browser writes that) but
-- no twitch_login, and their metadata holds the login under `name`, not `twitch_login`, so the backfill
-- missed them. Each such player is invisible to every invitation sent to their name - found when
-- ItsShura could neither see their team's invitation nor be added to it by an admin.
--
-- The login is taken from auth.identities, not user_metadata. A user can rewrite their own metadata
-- (auth.updateUser), so trusting it would let anyone claim someone else's handle - which guard_twitch_login
-- exists to stop. An identity row is written by the auth server from what Twitch returned, and its
-- provider_id has to be the profile's own twitch_id.

create or replace function public.twitch_login_from_identity(p_user uuid, p_twitch_id text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(i.identity_data ->> 'name')
    from auth.identities i
   where i.user_id = p_user
     and i.provider = 'twitch'
     and i.provider_id = p_twitch_id
     and lower(i.identity_data ->> 'name') ~ '^[a-z0-9_]{3,25}$'
   limit 1;
$$;

revoke all on function public.twitch_login_from_identity(uuid, text) from public, anon, authenticated;

-- Everyone already in this state. A handle another profile already holds is left alone: the unique
-- index would refuse it, and that other account is the one Twitch last vouched for.
update public.profiles p
   set twitch_login = public.twitch_login_from_identity(p.id, p.twitch_id)
 where p.twitch_login is null
   and p.twitch_id is not null
   and public.twitch_login_from_identity(p.id, p.twitch_id) is not null
   and not exists (
     select 1 from public.profiles o
      where o.id <> p.id
        and lower(o.twitch_login) = public.twitch_login_from_identity(p.id, p.twitch_id)
   );

-- And anyone who turns up in it later: the browser saves the profile on every visit, so the handle is
-- filled in the next time they open the site. Named to run AFTER profiles_guard_twitch_login (triggers
-- fire in name order) - the guard sees the caller's row with the handle still empty and lets it by,
-- then this fills it from the identity, which only the auth server writes.
create or replace function public.fill_twitch_login_from_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  found_login text;
begin
  if new.twitch_login is null and new.twitch_id is not null then
    found_login := public.twitch_login_from_identity(new.id, new.twitch_id);
    if found_login is not null
       and not exists (select 1 from profiles o where o.id <> new.id and lower(o.twitch_login) = found_login) then
      new.twitch_login := found_login;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_zz_twitch_login_from_identity on public.profiles;
create trigger profiles_zz_twitch_login_from_identity
  before insert or update on public.profiles
  for each row execute function public.fill_twitch_login_from_identity();
