-- Solo signup for team events, and the tools for admins to turn the people left over into teams.
--
-- In an event with team_size > 1 a player who has nobody to play with can still sign up: they go into
-- a pool of free agents, and an administrator pairs the pool into teams. (In an individual event -
-- team_size 1 - there is nothing to pair, so signing up solo is just signing up.)
--
-- -- Why a separate pool, not a team of one ---------------------------------------------------------
-- The obvious shortcut is to make a solo signup a pending team with a single player and let admins
-- merge teams. That fights the rest of the model: a team is an entrant with an id, a name, an entry
-- code and possibly a bracket slot, and merging two of them means deciding which id, name and code
-- survive and what happens to the one that doesn't. A player waiting for a team is not a team, so
-- they are not stored as one. They are a row in tournament_free_agents until they land on a roster.
--
-- -- The pool follows the roster, not the other way round -------------------------------------------
-- There is exactly one source of truth for "who is on which team": tournament_roster. A free agent's
-- status is derived from it by triggers, so no code path has to remember to update the pool:
--   * anyone who joins a roster - by accepting an invitation, by an admin placing them, by starting
--     their own team - leaves the pool ('placed');
--   * anyone taken off a roster, or whose team is rejected or withdrawn, goes back into it.
--
-- Who may see the pool: admins, and each player their own row. It is not published - a waiting
-- player's note ("EU evenings, plays support") is written for the organizers, not for the world.

create table if not exists public.tournament_free_agents (
  id                uuid primary key default gen_random_uuid(),
  tournament_id     uuid not null references public.tournaments(id) on delete cascade,
  user_id           uuid not null,
  -- Cached at signup, like the roster's, so the pool still reads sensibly if a profile is removed.
  display_name      text not null,
  note              text check (note is null or char_length(note) <= 200),
  status            text not null default 'waiting' check (status in ('waiting', 'placed', 'withdrawn')),
  placed_entrant_id uuid references public.tournament_entrants(id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (tournament_id, user_id)
);

create index if not exists tournament_free_agents_tournament_idx
  on public.tournament_free_agents (tournament_id, status);

alter table public.tournament_free_agents enable row level security;

drop policy if exists "free agents select" on public.tournament_free_agents;
create policy "free agents select" on public.tournament_free_agents for select
  using (public.is_admin() or user_id = auth.uid());

-- No INSERT/UPDATE/DELETE policies: every change goes through the functions below or the triggers.

-- ===========================================================================
--  The pool follows the roster
-- ===========================================================================

-- Joining any roster takes you out of the pool.
create or replace function public.free_agent_placed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update tournament_free_agents fa
     set status = 'placed', placed_entrant_id = new.entrant_id
    from tournament_entrants e
   where e.id = new.entrant_id
     and fa.tournament_id = e.tournament_id
     and fa.user_id = new.user_id
     and fa.status = 'waiting';
  return new;
end;
$$;

drop trigger if exists tournament_roster_free_agent_placed on public.tournament_roster;
create trigger tournament_roster_free_agent_placed
  after insert on public.tournament_roster
  for each row execute function public.free_agent_placed();

-- Leaving one (or being taken off it) puts you back - but only if this is the team you were placed
-- on, so a stray roster row can't drag someone out of a team they're actually on.
create or replace function public.free_agent_released_by_roster()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update tournament_free_agents fa
     set status = 'waiting', placed_entrant_id = null
   where fa.placed_entrant_id = old.entrant_id
     and fa.user_id = old.user_id
     and fa.status = 'placed';
  return old;
end;
$$;

drop trigger if exists tournament_roster_free_agent_released on public.tournament_roster;
create trigger tournament_roster_free_agent_released
  after delete on public.tournament_roster
  for each row execute function public.free_agent_released_by_roster();

-- A team that is rejected or withdrawn is no longer a team they are on: its free agents wait again.
-- (The roster rows stay, as a record; the roster guard already ignores teams in these states.)
create or replace function public.free_agent_released_by_team()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('rejected', 'withdrawn') and old.status not in ('rejected', 'withdrawn') then
    update tournament_free_agents fa
       set status = 'waiting', placed_entrant_id = null
     where fa.placed_entrant_id = new.id and fa.status = 'placed';
  end if;
  return new;
end;
$$;

drop trigger if exists tournament_entrants_free_agents_released on public.tournament_entrants;
create trigger tournament_entrants_free_agents_released
  after update of status on public.tournament_entrants
  for each row execute function public.free_agent_released_by_team();

-- ===========================================================================
--  Signing up solo
-- ===========================================================================
create or replace function public.sign_up_solo(p_tournament uuid, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  size int;
  who text;
  existing tournament_free_agents%rowtype;
  fid uuid;
begin
  if not public.is_twitch_user() then
    raise exception 'Sign in with Twitch to sign up';
  end if;
  if not public.tournament_signup_open(p_tournament) then
    raise exception 'Signup for this event is not open';
  end if;

  select t.team_size into size from tournaments t where t.id = p_tournament;
  if size = 1 then
    raise exception 'This is an individual event - sign up directly, there are no teams to be placed on';
  end if;

  if exists (
    select 1
      from tournament_roster r
      join tournament_entrants e on e.id = r.entrant_id
     where r.user_id = auth.uid()
       and e.tournament_id = p_tournament
       and e.status in ('pending', 'approved')
  ) then
    raise exception 'You are already on a team in this event';
  end if;

  select coalesce(p.display_name, 'Player') into who from profiles p where p.id = auth.uid();

  select * into existing from tournament_free_agents fa
   where fa.tournament_id = p_tournament and fa.user_id = auth.uid();

  if found then
    if existing.status = 'waiting' then
      -- Already in the pool; treat a second signup as an edit of the note.
      update tournament_free_agents set note = nullif(btrim(coalesce(p_note, '')), '') where id = existing.id;
      return existing.id;
    end if;
    -- Withdrawn earlier, or placed on a team that has since dissolved: back into the pool.
    update tournament_free_agents
       set status = 'waiting', placed_entrant_id = null, display_name = who,
           note = nullif(btrim(coalesce(p_note, '')), '')
     where id = existing.id;
    return existing.id;
  end if;

  insert into tournament_free_agents (tournament_id, user_id, display_name, note)
  values (p_tournament, auth.uid(), who, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into fid;
  return fid;
end;
$$;

grant execute on function public.sign_up_solo(uuid, text) to authenticated;

-- Change your mind before an admin has placed you.
create or replace function public.withdraw_solo(p_tournament uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update tournament_free_agents fa
     set status = 'withdrawn'
   where fa.tournament_id = p_tournament and fa.user_id = auth.uid() and fa.status = 'waiting';
  if not found then
    raise exception 'You are not waiting for a team in this event - if you have been placed, ask an administrator';
  end if;
end;
$$;

grant execute on function public.withdraw_solo(uuid) to authenticated;

-- ===========================================================================
--  Admin: pairing the pool into teams
-- ===========================================================================
-- Both tools only work before the event starts. Once it is live the bracket exists and is named after
-- the teams in it; a team appearing or growing mid-event is a different decision (a substitute) and
-- belongs to the admin's direct roster powers, not to this.

-- Turn waiting players into a new, approved team. One call, so a mistake - a player who has since
-- been placed elsewhere, a name already taken - leaves nothing half-built.
create or replace function public.form_team_from_free_agents(
  p_tournament uuid,
  p_name text,
  p_user_ids uuid[],
  p_captain uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  t_status text;
  cap int;
  n int;
  chosen uuid;
  eid uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can form teams';
  end if;

  select t.status, t.max_roster into t_status, cap from tournaments t where t.id = p_tournament;
  if t_status is null then
    raise exception 'There is no such event';
  end if;
  if t_status not in ('draft', 'signup') then
    raise exception 'Teams can only be formed before the event starts';
  end if;

  n := coalesce(array_length(p_user_ids, 1), 0);
  if n < 1 then
    raise exception 'Choose at least one player';
  end if;
  if n > cap then
    raise exception 'A team here can have at most % players', cap;
  end if;
  if (select count(distinct u) from unnest(p_user_ids) as u) <> n then
    raise exception 'The same player is listed twice';
  end if;
  if (
    select count(*) from tournament_free_agents fa
     where fa.tournament_id = p_tournament and fa.user_id = any(p_user_ids) and fa.status = 'waiting'
  ) <> n then
    raise exception 'Not every player is waiting for a team - someone has been placed or has withdrawn';
  end if;

  chosen := coalesce(p_captain, p_user_ids[1]);
  if not (chosen = any(p_user_ids)) then
    raise exception 'The captain must be one of the players';
  end if;

  -- Pending first, approved after: approval is what issues the team's entry code, and it does that
  -- on the status change rather than on insert.
  insert into tournament_entrants (tournament_id, name, captain_user_id)
  values (p_tournament, p_name, chosen)
  returning id into eid;

  insert into tournament_roster (entrant_id, user_id, display_name)
  select eid, fa.user_id, fa.display_name
    from tournament_free_agents fa
   where fa.tournament_id = p_tournament and fa.user_id = any(p_user_ids) and fa.user_id <> chosen;

  update tournament_entrants set status = 'approved' where id = eid;
  return eid;
end;
$$;

grant execute on function public.form_team_from_free_agents(uuid, text, uuid[], uuid) to authenticated;

-- Top up a team that is a player short with someone from the pool.
create or replace function public.assign_free_agent_to_team(p_entrant uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
  e_status text;
  t_status text;
  cap int;
  fa_name text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can place a player';
  end if;

  select e.tournament_id, e.status into tid, e_status from tournament_entrants e where e.id = p_entrant;
  if tid is null then
    raise exception 'There is no such team';
  end if;
  if e_status not in ('pending', 'approved') then
    raise exception 'That team is not taking players';
  end if;

  select t.status, t.max_roster into t_status, cap from tournaments t where t.id = tid;
  if t_status not in ('draft', 'signup') then
    raise exception 'Players can only be placed before the event starts';
  end if;

  select fa.display_name into fa_name from tournament_free_agents fa
   where fa.tournament_id = tid and fa.user_id = p_user and fa.status = 'waiting';
  if fa_name is null then
    raise exception 'That player is not waiting for a team';
  end if;

  if (select count(*) from tournament_roster r where r.entrant_id = p_entrant) >= cap then
    raise exception 'That team is full (% players)', cap;
  end if;

  insert into tournament_roster (entrant_id, user_id, display_name) values (p_entrant, p_user, fa_name);
end;
$$;

grant execute on function public.assign_free_agent_to_team(uuid, uuid) to authenticated;
