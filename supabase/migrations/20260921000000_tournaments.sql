-- Tournaments: events, signup, rosters, and the bracket's matches.
--
-- This is the schema half of the tournament system. The bracket itself - seeding, byes, the
-- loser-bracket topology, Swiss pairing - is generated in TypeScript (src/lib/tournament) in the
-- admin's browser and written here as plain rows. What lives in SQL is only what has to run with
-- nobody's browser open: recording a match's score and walking the winner (and loser) along the
-- pointers that generation stored on the match. That is tournament_apply_score(), below, and it is a
-- deliberate line-for-line mirror of setScore() in src/lib/tournament/bracket.ts - the TypeScript
-- is what scripts/check-tournament.ts exercises, so when one changes, the other must.
--
-- NOT in this migration, on purpose: linking a room to a tournament match ("official matches"), the
-- roster check at join time, and archive_match feeding results in. Those change rooms and
-- archive_match, which are load-bearing, and they get their own migration once this one has been
-- through a real signup.
--
-- -- Who can do what -------------------------------------------------------------------------------
--   admins       create and run events, approve entrants, enter or correct any result
--   Twitch users sign a team up while signup is open, naming teammates by Twitch username; each
--                teammate accepts to join the roster
--   everyone     read approved entrants and the bracket of any event that isn't a draft
--
-- Signup requires a Twitch account (profiles.twitch_id), not merely a signed-in session: the site
-- signs everyone in anonymously so the game works without an account, and a roster of anonymous
-- uuids is a roster nobody can be held to.

-- ===========================================================================
--  Helpers
-- ===========================================================================

-- True for a Twitch-backed account, false for the anonymous session every visitor gets.
create or replace function public.is_twitch_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from profiles p where p.id = auth.uid() and p.twitch_id is not null);
$$;

-- True when there is no end user behind the request: the SQL editor, a migration, or the edge
-- functions' service key. The guard triggers below use it to stay out of the way of maintenance.
-- An ordinary signed-in user is 'authenticated' and a bare visitor is 'anon', so neither passes.
-- Reads the request's JWT claims directly rather than through auth.role(), which is a deprecated
-- helper; PostgREST always sets the claims, so an empty setting means no request at all.
create or replace function public.is_service_session()
returns boolean
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
         in ('', 'service_role');
$$;

grant execute on function public.is_twitch_user() to anon, authenticated;
grant execute on function public.is_service_session() to anon, authenticated;

-- ===========================================================================
--  tournaments
-- ===========================================================================
-- status:
--   draft      only admins can see it; being set up
--   signup     open for entrants
--   live       running. This is what makes the "Official match" option exist in the lobby
--   finished   over; the bracket stays readable
--   cancelled  never ran
--
-- `format` is the TournamentFormat JSON (qualifier + knockout) and `match_settings` is what an
-- official room will be locked to (board size, square set, timers). Both are validated in the app
-- (src/lib/tournament/format.ts); the database holds them as data.
--
-- team_size 1 is an individual event: a team of one. There is no separate "solo" mode, which is
-- what lets every other rule - rosters, codes, brackets - stay the same for both.
create table if not exists public.tournaments (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(btrim(name)) between 3 and 80),
  description      text not null default '',
  status           text not null default 'draft'
                     check (status in ('draft', 'signup', 'live', 'finished', 'cancelled')),
  team_size        int  not null default 1 check (team_size between 1 and 10),
  -- Team size plus substitutes. An event of 3-player teams with two subs is team_size 3, max_roster 5.
  max_roster       int  not null default 1,
  max_entrants     int  check (max_entrants is null or max_entrants >= 2),
  signup_closes_at timestamptz,
  starts_at        timestamptz,
  format           jsonb not null default '{}'::jsonb,
  match_settings   jsonb not null default '{}'::jsonb,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tournaments_roster_covers_team check (max_roster >= team_size)
);

alter table public.tournaments enable row level security;

drop policy if exists "tournaments select" on public.tournaments;
create policy "tournaments select" on public.tournaments for select
  using (status <> 'draft' or public.is_admin());

drop policy if exists "tournaments insert by admin" on public.tournaments;
create policy "tournaments insert by admin" on public.tournaments for insert
  with check (public.is_admin());

drop policy if exists "tournaments update by admin" on public.tournaments;
create policy "tournaments update by admin" on public.tournaments for update
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "tournaments delete by admin" on public.tournaments;
create policy "tournaments delete by admin" on public.tournaments for delete
  using (public.is_admin());

-- Once an event is live its shape is fixed. Editing the format under a running bracket would leave
-- matches that no longer match the rules that produced them; the fix for a wrong format is to
-- cancel and re-create, not to edit it in place. UPDATE only, and the SQL editor stays exempt.
create or replace function public.guard_tournament_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.is_service_session() then
    return new;
  end if;
  if old.status in ('live', 'finished')
     and (new.format is distinct from old.format
          or new.team_size is distinct from old.team_size
          or new.max_roster is distinct from old.max_roster) then
    raise exception 'This event is already running - its format and team size can no longer be changed';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tournaments_guard_update on public.tournaments;
create trigger tournaments_guard_update
  before update on public.tournaments
  for each row execute function public.guard_tournament_update();

-- Whether a tournament is taking signups right now. Definer so the entrant and roster rules can ask
-- it without the asker needing to be able to read the tournament row itself.
create or replace function public.tournament_signup_open(p_tournament uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from tournaments t
     where t.id = p_tournament
       and t.status = 'signup'
       and (t.signup_closes_at is null or t.signup_closes_at > now())
  );
$$;

grant execute on function public.tournament_signup_open(uuid) to anon, authenticated;

-- ===========================================================================
--  tournament_entrants
-- ===========================================================================
-- One row per team (or per player, in an individual event) per event. Rosters are per event, always:
-- there is no persistent team object, so a team that plays two events signs up twice.
--
-- status: pending (awaiting an admin) -> approved | rejected; withdrawn is the captain's own exit.
create table if not exists public.tournament_entrants (
  id              uuid primary key default gen_random_uuid(),
  tournament_id   uuid not null references public.tournaments(id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 2 and 40),
  captain_user_id uuid not null default auth.uid(),
  status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  seed            int check (seed is null or seed >= 1),
  created_at      timestamptz not null default now()
);

-- Two live teams can't share a name (it would make the bracket unreadable), but a rejected or
-- withdrawn team's name is free again.
create unique index if not exists tournament_entrants_name_uniq
  on public.tournament_entrants (tournament_id, lower(btrim(name)))
  where status in ('pending', 'approved');
create unique index if not exists tournament_entrants_seed_uniq
  on public.tournament_entrants (tournament_id, seed)
  where seed is not null;
create index if not exists tournament_entrants_tournament_idx
  on public.tournament_entrants (tournament_id);

-- ===========================================================================
--  tournament_roster
-- ===========================================================================
-- display_name is cached at join time so the roster still reads sensibly if a profile is ever
-- removed - the same choice `admins` makes.
create table if not exists public.tournament_roster (
  entrant_id   uuid not null references public.tournament_entrants(id) on delete cascade,
  user_id      uuid not null,
  display_name text not null,
  is_captain   boolean not null default false,
  joined_at    timestamptz not null default now(),
  primary key (entrant_id, user_id)
);

create index if not exists tournament_roster_user_idx on public.tournament_roster (user_id);

-- -- Membership helpers ---------------------------------------------------------------------------
-- Definer, for the same reason as is_admin(): the entrants policy has to ask "is this person on the
-- roster" and the roster policy has to ask "is this entrant approved", and if each read the other
-- table under the caller's rights the two policies would evaluate each other forever.
--
-- They sit here, after both tables, because a LANGUAGE sql function is checked when it is created
-- and refuses to reference a table that doesn't exist yet.
create or replace function public.is_entrant_captain(p_entrant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from tournament_entrants e where e.id = p_entrant and e.captain_user_id = auth.uid()
  );
$$;

create or replace function public.is_entrant_member(p_entrant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from tournament_roster r where r.entrant_id = p_entrant and r.user_id = auth.uid()
  );
$$;

create or replace function public.is_entrant_approved(p_entrant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from tournament_entrants e where e.id = p_entrant and e.status = 'approved'
  );
$$;

grant execute on function public.is_entrant_captain(uuid) to anon, authenticated;
grant execute on function public.is_entrant_member(uuid) to anon, authenticated;
grant execute on function public.is_entrant_approved(uuid) to anon, authenticated;

alter table public.tournament_roster enable row level security;
alter table public.tournament_entrants enable row level security;

-- -- Entrant policies -----------------------------------------------------------------------------
-- The public sees approved teams only. A pending team is visible to its own captain and roster, and
-- to admins - not to the world, so a captain can register and still be reworking the name.
drop policy if exists "entrants select" on public.tournament_entrants;
create policy "entrants select" on public.tournament_entrants for select
  using (
    status = 'approved'
    or captain_user_id = auth.uid()
    or public.is_entrant_member(id)
    or public.is_admin()
  );

-- A captain registers their own team, pending and unseeded, while signup is open. Every other field
-- is forced by the WITH CHECK, not trusted from the client.
drop policy if exists "entrants insert by captain" on public.tournament_entrants;
create policy "entrants insert by captain" on public.tournament_entrants for insert
  with check (
    captain_user_id = auth.uid()
    and status = 'pending'
    and seed is null
    and public.is_twitch_user()
    and public.tournament_signup_open(tournament_id)
  );

drop policy if exists "entrants insert by admin" on public.tournament_entrants;
create policy "entrants insert by admin" on public.tournament_entrants for insert
  with check (public.is_admin());

-- RLS cannot compare old to new, so what a captain may CHANGE is the trigger's job. The policy only
-- decides whose row it is.
drop policy if exists "entrants update by captain or admin" on public.tournament_entrants;
create policy "entrants update by captain or admin" on public.tournament_entrants for update
  using (captain_user_id = auth.uid() or public.is_admin())
  with check (captain_user_id = auth.uid() or public.is_admin());

drop policy if exists "entrants delete by admin" on public.tournament_entrants;
create policy "entrants delete by admin" on public.tournament_entrants for delete
  using (public.is_admin());

-- -- Roster policies ------------------------------------------------------------------------------
drop policy if exists "roster select" on public.tournament_roster;
create policy "roster select" on public.tournament_roster for select
  using (
    user_id = auth.uid()
    or public.is_entrant_captain(entrant_id)
    or public.is_entrant_approved(entrant_id)
    or public.is_admin()
  );

-- No INSERT policy for ordinary users: the captain's own row is written by the trigger below and
-- everyone else joins by accepting an invitation (respond_to_roster_invite). Admins can place anyone
-- anywhere.
drop policy if exists "roster insert by admin" on public.tournament_roster;
create policy "roster insert by admin" on public.tournament_roster for insert
  with check (public.is_admin());

-- Leaving a team, or a captain removing someone (never themselves - a team needs its captain),
-- while signup is still open. After that the roster is admin-only.
drop policy if exists "roster delete" on public.tournament_roster;
create policy "roster delete" on public.tournament_roster for delete
  using (
    public.is_admin()
    or (
      not is_captain
      and (user_id = auth.uid() or public.is_entrant_captain(entrant_id))
      and exists (
        select 1 from tournament_entrants e
         where e.id = entrant_id and public.tournament_signup_open(e.tournament_id)
      )
    )
  );

-- -- Entrant guard --------------------------------------------------------------------------------
-- Definer so the capacity count sees every row rather than only the ones the caller may read. A
-- count made under the caller's RLS would see just the approved teams and their own, and "the event
-- is full" would never trigger.
create or replace function public.guard_tournament_entrant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cap int;
  taken int;
begin
  if public.is_service_session() or public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    select t.max_entrants into cap from tournaments t where t.id = new.tournament_id;
    select count(*) into taken from tournament_entrants e
     where e.tournament_id = new.tournament_id and e.status in ('pending', 'approved');
    if cap is not null and taken >= cap then
      raise exception 'This event is full';
    end if;

    if exists (
      select 1
        from tournament_roster r
        join tournament_entrants e on e.id = r.entrant_id
       where r.user_id = new.captain_user_id
         and e.tournament_id = new.tournament_id
         and e.status in ('pending', 'approved')
    ) then
      raise exception 'You are already on a team in this event';
    end if;
    return new;
  end if;

  -- UPDATE, by a captain. They may rename the team while signup is open, or withdraw it.
  if new.tournament_id is distinct from old.tournament_id
     or new.captain_user_id is distinct from old.captain_user_id
     or new.seed is distinct from old.seed then
    raise exception 'Only an administrator can change that';
  end if;

  if new.status is distinct from old.status then
    if new.status <> 'withdrawn' then
      raise exception 'Only an administrator can approve or reject a team';
    end if;
    -- Once the event is running the team is in the bracket, and pulling it out is a decision about
    -- everyone it is scheduled to play - an administrator's, not the captain's.
    if not public.tournament_signup_open(old.tournament_id) then
      raise exception 'Signup has closed - ask an administrator to withdraw the team';
    end if;
    return new;
  end if;

  if new.name is distinct from old.name and not public.tournament_signup_open(old.tournament_id) then
    raise exception 'Signup has closed - ask an administrator to change the team name';
  end if;
  return new;
end;
$$;

drop trigger if exists tournament_entrants_guard on public.tournament_entrants;
create trigger tournament_entrants_guard
  before insert or update on public.tournament_entrants
  for each row execute function public.guard_tournament_entrant();

-- -- Roster guard ---------------------------------------------------------------------------------
create or replace function public.guard_tournament_roster()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
  ent_status text;
  cap int;
  size int;
begin
  if public.is_service_session() or public.is_admin() then
    return new;
  end if;

  select e.tournament_id, e.status into tid, ent_status
    from tournament_entrants e where e.id = new.entrant_id;
  if ent_status not in ('pending', 'approved') then
    raise exception 'That team is not taking players';
  end if;
  if not public.tournament_signup_open(tid) then
    raise exception 'Signup for this event has closed';
  end if;

  select t.max_roster into cap from tournaments t where t.id = tid;
  select count(*) into size from tournament_roster r where r.entrant_id = new.entrant_id;
  if size >= cap then
    raise exception 'That roster is full (% players)', cap;
  end if;

  if exists (
    select 1
      from tournament_roster r
      join tournament_entrants e on e.id = r.entrant_id
     where r.user_id = new.user_id
       and e.tournament_id = tid
       and e.status in ('pending', 'approved')
       and r.entrant_id <> new.entrant_id
  ) then
    raise exception 'That player is already on another team in this event';
  end if;
  return new;
end;
$$;

drop trigger if exists tournament_roster_guard on public.tournament_roster;
create trigger tournament_roster_guard
  before insert on public.tournament_roster
  for each row execute function public.guard_tournament_roster();

-- ===========================================================================
--  Secrets: entry codes
-- ===========================================================================
-- Kept out of tournament_entrants because RLS is per row, not per column: the entrants table is
-- readable by the public and the entry code must not be. Readable only by admins and by the team's
-- own captain.
--
--   entry_code    - the password an approved team gives to start an official match. Made when an
--                   admin approves the team; an admin can re-issue it. Unique within an event.
--
-- Written only by the triggers and functions below, so there are no INSERT/UPDATE policies at all.
create table if not exists public.tournament_entrant_secrets (
  entrant_id    uuid primary key references public.tournament_entrants(id) on delete cascade,
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  entry_code    text,
  unique (tournament_id, entry_code)
);

alter table public.tournament_entrant_secrets enable row level security;

drop policy if exists "secrets select" on public.tournament_entrant_secrets;
create policy "secrets select" on public.tournament_entrant_secrets for select
  using (public.is_admin() or public.is_entrant_captain(entrant_id));

-- Six characters from an alphabet with nothing that can be misread over a voice call or a stream
-- overlay: no 0/O, 1/I/L. This is a deterrent against strangers starting official matches, not a
-- credential worth an attacker's time, so random() is enough.
create or replace function public.make_entry_code()
returns text
language plpgsql
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text := '';
begin
  for i in 1..6 loop
    code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return code;
end;
$$;

-- Gives an entrant a fresh, unused entry code. Retries on the (rare) collision within an event.
create or replace function public.assign_entry_code(p_entrant uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
  code text;
begin
  select e.tournament_id into tid from tournament_entrants e where e.id = p_entrant;
  for attempt in 1..50 loop
    code := public.make_entry_code();
    begin
      update tournament_entrant_secrets s set entry_code = code where s.entrant_id = p_entrant;
      if not found then
        raise exception 'That team has no secrets row to hold a code';
      end if;
      return code;
    exception when unique_violation then
      null; -- taken by another team in this event; draw again
    end;
  end loop;
  raise exception 'Could not find a free entry code';
end;
$$;

revoke all on function public.assign_entry_code(uuid) from public, anon, authenticated;

-- A new entrant gets its secrets row and its captain on the roster. AFTER INSERT and definer: the
-- captain's roster row is exactly what the roster guard would otherwise have to be talked into.
create or replace function public.tournament_entrant_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into tournament_entrant_secrets (entrant_id, tournament_id)
  values (new.id, new.tournament_id);

  insert into tournament_roster (entrant_id, user_id, display_name, is_captain)
  select new.id, new.captain_user_id, coalesce(p.display_name, 'Captain'), true
    from (select 1) as one
    left join profiles p on p.id = new.captain_user_id;
  return new;
end;
$$;

drop trigger if exists tournament_entrants_created on public.tournament_entrants;
create trigger tournament_entrants_created
  after insert on public.tournament_entrants
  for each row execute function public.tournament_entrant_created();

-- Approving a team issues its entry code, once. Re-approving doesn't rotate it: a code that changed
-- underneath a team would be worse than none.
create or replace function public.tournament_entrant_approved()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    if exists (select 1 from tournament_entrant_secrets s where s.entrant_id = new.id and s.entry_code is null) then
      perform public.assign_entry_code(new.id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tournament_entrants_approved on public.tournament_entrants;
create trigger tournament_entrants_approved
  after update of status on public.tournament_entrants
  for each row execute function public.tournament_entrant_approved();

-- Admin: issue a team a new entry code (they lost it, or it leaked).
create or replace function public.regenerate_entry_code(p_entrant uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can re-issue an entry code';
  end if;
  if not exists (select 1 from tournament_entrants e where e.id = p_entrant and e.status = 'approved') then
    raise exception 'Only an approved team has an entry code';
  end if;
  return public.assign_entry_code(p_entrant);
end;
$$;

grant execute on function public.regenerate_entry_code(uuid) to authenticated;

-- ===========================================================================
--  Roster invitations, by Twitch name
-- ===========================================================================
-- One teammate signs the whole team up by typing everyone's Twitch username. Each name becomes an
-- invitation; the person it names sees it the next time they are signed in with Twitch, and joins
-- the roster by accepting.
--
-- Invitations rather than adding people outright, because being on a roster has a cost to the person
-- on it: nobody can be on two teams in an event, so a captain who could put any name on their roster
-- could also take that person out of the running for the team they meant to join. Consent is one
-- click and closes that off.
--
-- The name is matched against profiles.twitch_login, so an invitation can be sent to someone who has
-- never opened the site - it simply waits. Twitch logins are unique and case-insensitive, and are
-- stored lower-case here to match the profiles index.

create or replace function public.normalize_twitch_login(p text)
returns text
language sql
immutable
as $$
  select lower(regexp_replace(btrim(coalesce(p, '')), '^@', ''));
$$;

-- The signed-in account's own Twitch login, lower-cased; null for an anonymous session.
create or replace function public.my_twitch_login()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(p.twitch_login) from profiles p where p.id = auth.uid();
$$;

create or replace function public.entrant_signup_open(p_entrant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from tournament_entrants e
     where e.id = p_entrant and public.tournament_signup_open(e.tournament_id)
  );
$$;

grant execute on function public.normalize_twitch_login(text) to anon, authenticated;
grant execute on function public.my_twitch_login() to anon, authenticated;
grant execute on function public.entrant_signup_open(uuid) to anon, authenticated;

create table if not exists public.tournament_invites (
  id           uuid primary key default gen_random_uuid(),
  entrant_id   uuid not null references public.tournament_entrants(id) on delete cascade,
  twitch_login text not null check (twitch_login ~ '^[a-z0-9_]{3,25}$'),
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  invited_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  unique (entrant_id, twitch_login)
);

-- "Who has invited me?" is asked on every page load by a signed-in user, so it wants an index.
create index if not exists tournament_invites_login_idx
  on public.tournament_invites (twitch_login) where status = 'pending';

alter table public.tournament_invites enable row level security;

-- The invitee sees their own invitations; the captain sees their team's; admins see all.
drop policy if exists "invites select" on public.tournament_invites;
create policy "invites select" on public.tournament_invites for select
  using (
    public.is_admin()
    or public.is_entrant_captain(entrant_id)
    or twitch_login = public.my_twitch_login()
  );

-- A captain can withdraw an invitation that hasn't been answered, while signup is open. Creating and
-- answering them is only possible through the functions below - there is no INSERT or UPDATE policy.
drop policy if exists "invites delete" on public.tournament_invites;
create policy "invites delete" on public.tournament_invites for delete
  using (
    public.is_admin()
    or (
      status = 'pending'
      and public.is_entrant_captain(entrant_id)
      and public.entrant_signup_open(entrant_id)
    )
  );

-- Invite people to a team by Twitch username. Captain (or an admin) only. All-or-nothing: one bad
-- name and none are sent, so a typo can't leave a half-invited roster.
create or replace function public.invite_to_roster(p_entrant uuid, p_logins text[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
  ent_status text;
  cap int;
  v_login text;
  sent int := 0;
  touched int;
begin
  if not (public.is_admin() or public.is_entrant_captain(p_entrant)) then
    raise exception 'Only the team captain can invite players';
  end if;

  select e.tournament_id, e.status into tid, ent_status from tournament_entrants e where e.id = p_entrant;
  if tid is null then
    raise exception 'There is no such team';
  end if;
  if ent_status not in ('pending', 'approved') then
    raise exception 'That team is not taking players';
  end if;
  if not public.is_admin() and not public.tournament_signup_open(tid) then
    raise exception 'Signup for this event has closed';
  end if;

  foreach v_login in array coalesce(p_logins, '{}') loop
    v_login := public.normalize_twitch_login(v_login);
    if v_login = '' then
      continue;
    end if;
    if v_login !~ '^[a-z0-9_]{3,25}$' then
      raise exception '"%" is not a Twitch username', v_login;
    end if;
    if exists (
      select 1 from tournament_roster r
        join profiles p on p.id = r.user_id
       where r.entrant_id = p_entrant and lower(p.twitch_login) = v_login
    ) then
      raise exception '% is already on this team', v_login;
    end if;

    insert into tournament_invites (entrant_id, twitch_login)
    values (p_entrant, v_login)
    on conflict (entrant_id, twitch_login) do update set status = 'pending'
      where tournament_invites.status <> 'pending';
    get diagnostics touched = row_count;
    sent := sent + touched;
  end loop;

  -- Everyone on the roster plus everyone still deciding must fit. Counting the invitations already
  -- pending as well means a captain can't queue up more invitations than there are places.
  select t.max_roster into cap from tournaments t where t.id = tid;
  if (select count(*) from tournament_roster r where r.entrant_id = p_entrant)
     + (select count(*) from tournament_invites i where i.entrant_id = p_entrant and i.status = 'pending') > cap then
    raise exception 'A team can have at most % players, counting invitations still waiting', cap;
  end if;

  return sent;
end;
$$;

grant execute on function public.invite_to_roster(uuid, text[]) to authenticated;

-- Sign a team up in one step: the caller becomes captain and everyone they name is invited. One call
-- so a failure - the event is full, a name is wrong - leaves nothing behind. Rejected teams etc. are
-- handled by the same guard trigger a direct INSERT goes through.
create or replace function public.register_team(p_tournament uuid, p_name text, p_logins text[] default '{}')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  eid uuid;
begin
  if not public.is_twitch_user() then
    raise exception 'Sign in with Twitch to sign a team up';
  end if;
  if not public.tournament_signup_open(p_tournament) then
    raise exception 'Signup for this event is not open';
  end if;

  insert into tournament_entrants (tournament_id, name, captain_user_id)
  values (p_tournament, p_name, auth.uid())
  returning id into eid;

  if coalesce(array_length(p_logins, 1), 0) > 0 then
    perform public.invite_to_roster(eid, p_logins);
  end if;
  return eid;
end;
$$;

grant execute on function public.register_team(uuid, text, text[]) to authenticated;

-- Accept or decline an invitation addressed to your Twitch name. Accepting goes through the roster
-- guard like any other join - a full roster, closed signup, or being on another team already all
-- refuse it, and because that raises, the invitation stays pending rather than being burned.
create or replace function public.respond_to_roster_invite(p_invite uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  inv tournament_invites%rowtype;
begin
  if not public.is_twitch_user() then
    raise exception 'Sign in with Twitch to answer an invitation';
  end if;

  select * into inv from tournament_invites i where i.id = p_invite for update;
  if not found then
    raise exception 'That invitation no longer exists';
  end if;
  if inv.twitch_login is distinct from public.my_twitch_login() then
    raise exception 'That invitation is not for you';
  end if;
  if inv.status <> 'pending' then
    raise exception 'You have already answered that invitation';
  end if;

  if p_accept then
    insert into tournament_roster (entrant_id, user_id, display_name)
    select inv.entrant_id, auth.uid(), coalesce(p.display_name, inv.twitch_login)
      from (select 1) as one
      left join profiles p on p.id = auth.uid();
    update tournament_invites set status = 'accepted' where id = inv.id;
  else
    update tournament_invites set status = 'declined' where id = inv.id;
  end if;
end;
$$;

grant execute on function public.respond_to_roster_invite(uuid, boolean) to authenticated;

-- ===========================================================================
--  tournament_matches
-- ===========================================================================
-- One row per match, in the shape of TMatch (src/lib/tournament/types.ts). `key` is the engine's
-- stable name for the match ("W2-1", "GF1", "S3-0"), and winner_to_* / loser_to_* are the pointers
-- generation stored, which is all tournament_apply_score needs to advance a bracket.
create table if not exists public.tournament_matches (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  key            text not null,
  stage          text not null check (stage in ('swiss', 'group', 'knockout')),
  bracket        text check (bracket in ('W', 'L', 'GF', 'TP')),
  grp            int,
  round          int not null,
  idx            int not null,
  entrant_a      uuid references public.tournament_entrants(id) on delete set null,
  entrant_b      uuid references public.tournament_entrants(id) on delete set null,
  best_of        int not null default 1 check (best_of >= 1 and best_of % 2 = 1),
  score_a        int not null default 0 check (score_a >= 0),
  score_b        int not null default 0 check (score_b >= 0),
  status         text not null default 'pending'
                   check (status in ('pending', 'ready', 'in_progress', 'done', 'skipped')),
  winner         uuid references public.tournament_entrants(id) on delete set null,
  winner_to_key  text,
  winner_to_side text check (winner_to_side in ('a', 'b')),
  loser_to_key   text,
  loser_to_side  text check (loser_to_side in ('a', 'b')),
  reset_of       text,
  is_bye         boolean not null default false,
  updated_at     timestamptz not null default now(),
  unique (tournament_id, key)
);

create index if not exists tournament_matches_tournament_idx on public.tournament_matches (tournament_id, stage, round);

alter table public.tournament_matches enable row level security;

-- Definer: a draft tournament is invisible, and its matches must be too - but the matches policy
-- can't read the tournaments row itself if the caller isn't allowed to see it.
create or replace function public.tournament_visible(p_tournament uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or exists (select 1 from tournaments t where t.id = p_tournament and t.status <> 'draft');
$$;

grant execute on function public.tournament_visible(uuid) to anon, authenticated;

drop policy if exists "tournament_matches select" on public.tournament_matches;
create policy "tournament_matches select" on public.tournament_matches for select
  using (public.tournament_visible(tournament_id));

-- Admins write bracket rows directly when they generate a stage (the engine runs in their browser)
-- and when they draw the next Swiss round. Scores go through the functions below instead.
drop policy if exists "tournament_matches write by admin" on public.tournament_matches;
create policy "tournament_matches write by admin" on public.tournament_matches for all
  using (public.is_admin()) with check (public.is_admin());

-- ===========================================================================
--  Recording a result
-- ===========================================================================
-- Everything below mirrors setScore()/apply()/retract() in src/lib/tournament/bracket.ts, and reads
-- best against it. The rules in one breath:
--
--   * A score is valid if neither side passes the winning total and they don't both reach it.
--   * Reaching it decides the match: the winner goes to winner_to, the loser to loser_to.
--   * Changing a decided match's WINNER is refused once anything it fed has been played; changing
--     only the score (2-1 to 2-0) never touches downstream and is always allowed.
--   * The grand final is the one match with a side effect beyond its pointers: if the loser-bracket
--     finalist (side b) wins it, the reset is dealt the same two teams; if not, the reset is skipped.

-- Writes an entrant into one side of a match and re-derives whether it is ready.
create or replace function public.tournament_place(p_tournament uuid, p_key text, p_side text, p_entrant uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_side = 'a' then
    update tournament_matches t
       set entrant_a = p_entrant,
           status = case when p_entrant is not null and t.entrant_b is not null then 'ready' else 'pending' end,
           updated_at = now()
     where t.tournament_id = p_tournament and t.key = p_key;
  else
    update tournament_matches t
       set entrant_b = p_entrant,
           status = case when p_entrant is not null and t.entrant_a is not null then 'ready' else 'pending' end,
           updated_at = now()
     where t.tournament_id = p_tournament and t.key = p_key;
  end if;
end;
$$;

revoke all on function public.tournament_place(uuid, text, text, uuid) from public, anon, authenticated;

create or replace function public.tournament_apply_score(p_match uuid, p_score_a int, p_score_b int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m        tournament_matches%rowtype;
  tgt      tournament_matches%rowtype;
  rst      tournament_matches%rowtype;
  need     int;
  decided  text;
  prior    text;
begin
  select * into m from tournament_matches where id = p_match;
  if not found then
    raise exception 'There is no such tournament match';
  end if;

  -- One result at a time per event. Two official games can end in the same second, and both write
  -- into the same next-round match; without this they would each read it as empty.
  perform pg_advisory_xact_lock(hashtext(m.tournament_id::text));
  select * into m from tournament_matches where id = p_match;

  if m.status = 'skipped' then
    raise exception '% is not needed - the grand final was already decisive', m.key;
  end if;
  if m.entrant_a is null or m.entrant_b is null then
    raise exception '% is still waiting on earlier results', m.key;
  end if;
  if p_score_a < 0 or p_score_b < 0 then
    raise exception 'A score is a whole number of games, zero or more';
  end if;

  need := m.best_of / 2 + 1;
  if p_score_a > need or p_score_b > need or (p_score_a = need and p_score_b = need) then
    raise exception 'In a best of % the winner takes % games and the loser fewer', m.best_of, need;
  end if;

  decided := case when p_score_a = need then 'a' when p_score_b = need then 'b' else null end;
  prior   := case when m.winner is null then null when m.winner = m.entrant_a then 'a' else 'b' end;

  -- Retract: the decided winner is changing (or being cleared), so what it sent downstream comes back.
  if prior is not null and prior is distinct from decided then
    if m.winner_to_key is not null then
      select * into tgt from tournament_matches where tournament_id = m.tournament_id and key = m.winner_to_key;
      if tgt.score_a + tgt.score_b > 0 or tgt.winner is not null then
        raise exception 'Cannot change %: % has already been played', m.key, tgt.key;
      end if;
    end if;
    if m.loser_to_key is not null then
      select * into tgt from tournament_matches where tournament_id = m.tournament_id and key = m.loser_to_key;
      if tgt.score_a + tgt.score_b > 0 or tgt.winner is not null then
        raise exception 'Cannot change %: % has already been played', m.key, tgt.key;
      end if;
    end if;
    select * into rst from tournament_matches where tournament_id = m.tournament_id and reset_of = m.key;
    if found and (rst.score_a + rst.score_b > 0 or rst.winner is not null) then
      raise exception 'Cannot change %: the reset (%) has already been played', m.key, rst.key;
    end if;

    if m.winner_to_key is not null then
      perform public.tournament_place(m.tournament_id, m.winner_to_key, m.winner_to_side, null);
    end if;
    if m.loser_to_key is not null then
      perform public.tournament_place(m.tournament_id, m.loser_to_key, m.loser_to_side, null);
    end if;
    if rst.id is not null then
      update tournament_matches
         set entrant_a = null, entrant_b = null, status = 'pending', updated_at = now()
       where id = rst.id;
    end if;
  end if;

  update tournament_matches
     set score_a = p_score_a,
         score_b = p_score_b,
         winner  = case decided when 'a' then entrant_a when 'b' then entrant_b else null end,
         status  = case
                     when decided is not null then 'done'
                     when p_score_a + p_score_b > 0 then 'in_progress'
                     else 'ready'
                   end,
         updated_at = now()
   where id = m.id;

  -- Apply: a newly decided winner goes along its pointers.
  if decided is not null and prior is distinct from decided then
    if m.winner_to_key is not null then
      perform public.tournament_place(
        m.tournament_id, m.winner_to_key, m.winner_to_side,
        case decided when 'a' then m.entrant_a else m.entrant_b end);
    end if;
    if m.loser_to_key is not null then
      perform public.tournament_place(
        m.tournament_id, m.loser_to_key, m.loser_to_side,
        case decided when 'a' then m.entrant_b else m.entrant_a end);
    end if;

    select * into rst from tournament_matches where tournament_id = m.tournament_id and reset_of = m.key;
    if found then
      if decided = 'b' then
        update tournament_matches
           set entrant_a = m.entrant_a, entrant_b = m.entrant_b, status = 'ready', updated_at = now()
         where id = rst.id;
      else
        update tournament_matches
           set entrant_a = null, entrant_b = null, status = 'skipped', updated_at = now()
         where id = rst.id;
      end if;
    end if;
  end if;
end;
$$;

-- The internal entry point. archive_match will call this (from the next migration) when an official
-- game ends; no client may, or anyone could crown themselves.
revoke all on function public.tournament_apply_score(uuid, int, int) from public, anon, authenticated;

-- One more game to `side` ('a' or 'b') - what archive_match will do per official game. Refuses a
-- decided series, which the plain setScore would accept as a same-winner "correction".
create or replace function public.tournament_record_game(p_match uuid, p_side text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m tournament_matches%rowtype;
begin
  select * into m from tournament_matches where id = p_match;
  if not found then
    raise exception 'There is no such tournament match';
  end if;
  if m.winner is not null then
    raise exception '% is already decided', m.key;
  end if;
  perform public.tournament_apply_score(
    p_match,
    m.score_a + case when p_side = 'a' then 1 else 0 end,
    m.score_b + case when p_side = 'b' then 1 else 0 end);
end;
$$;

revoke all on function public.tournament_record_game(uuid, text) from public, anon, authenticated;

-- -- What admins can call -------------------------------------------------------------------------

-- Enter or correct a result: 2-1, 0-2, or 0-0 to clear the match (revert).
create or replace function public.set_tournament_match_score(p_match uuid, p_score_a int, p_score_b int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m tournament_matches%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can enter a result';
  end if;
  select * into m from tournament_matches where id = p_match;
  if found and p_score_a = 0 and p_score_b = 0 and m.score_a + m.score_b = 0 and m.winner is null then
    raise exception '% has no result to revert', m.key;
  end if;
  perform public.tournament_apply_score(p_match, p_score_a, p_score_b);
end;
$$;

grant execute on function public.set_tournament_match_score(uuid, int, int) to authenticated;
