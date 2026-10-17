-- A team's name and logo stay the captain's until the team plays its first match.
--
-- Until now a captain could rename the team or change its logo only while signup was open. But a pair
-- that signed up "looking for players" only becomes a full crew when an administrator adds a solo player
-- - often after signup has closed - and that new crew of three should get to choose its name and logo
-- together. So the window now runs from signup until the team's own first match starts, per team: a team
-- whose first match comes later keeps the window longer.
--
-- "Started" means either of:
--   * a non-bye match of theirs has a game recorded on it ('in_progress' or 'done' - a forfeit or an
--     administrator's result counts too: the match is settled, the name is on the record), or
--   * an official room linked to one of their matches has left the lobby - the game is under way and the
--     name is on stream. A room still in the lobby can be unlinked, so linking alone does not lock.
--
-- Administrators can still change either at any time (the guard lets them straight through), for an
-- offensive name mid-event or a logo that needs taking down.

-- Whether the captain of this team may still change its name and logo. Definer for the same reason as
-- tournament_signup_open: the guard and the storage policies ask it on the caller's behalf.
create or replace function public.team_identity_open(p_entrant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from tournament_entrants e
      join tournaments t on t.id = e.tournament_id
     where e.id = p_entrant
       and e.status in ('pending', 'approved')
       and e.forfeited_at is null
       and (
         public.tournament_signup_open(t.id)
         or (
           t.status in ('signup', 'live')
           and not exists (
             select 1 from tournament_matches m
              where (m.entrant_a = e.id or m.entrant_b = e.id)
                and m.entrant_a is not null and m.entrant_b is not null
                and not m.is_bye
                and m.status in ('in_progress', 'done')
           )
           and not exists (
             select 1 from rooms r
               join tournament_matches m on m.id = r.tournament_match_id
              where (m.entrant_a = e.id or m.entrant_b = e.id)
                and r.status <> 'lobby'
           )
         )
       )
  );
$$;

grant execute on function public.team_identity_open(uuid) to authenticated;

-- ===========================================================================
--  The logo storage rule
-- ===========================================================================
-- As in 20261008000000_team_logos.sql, but the captain's window is team_identity_open rather than
-- signup alone. The policies themselves call this function, so they need no change.
create or replace function public.can_edit_team_logo(p_object text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ent uuid;
begin
  if public.is_admin() then
    return true;
  end if;
  begin
    ent := split_part(p_object, '/', 1)::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return exists (select 1 from tournament_entrants e where e.id = ent and e.captain_user_id = auth.uid())
     and public.team_identity_open(ent);
end;
$$;

-- ===========================================================================
--  The entrant guard
-- ===========================================================================
-- Reproduced in full from 20261008000000_team_logos.sql (create or replace cannot patch a body). The one
-- change: a captain's rename and logo change are checked against team_identity_open instead of signup.
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
    if new.forfeited_at is not null then
      raise exception 'Only an administrator can change that';
    end if;

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

  -- UPDATE, by a captain. They may rename the team or change its logo until its first match, or withdraw
  -- it while signup is open.
  if new.tournament_id is distinct from old.tournament_id
     or new.captain_user_id is distinct from old.captain_user_id
     or new.seed is distinct from old.seed
     or new.forfeited_at is distinct from old.forfeited_at then
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

  if new.name is distinct from old.name and not public.team_identity_open(old.id) then
    raise exception 'Your team has played its first match - ask an administrator to change the team name';
  end if;
  if new.logo_path is distinct from old.logo_path and not public.team_identity_open(old.id) then
    raise exception 'Your team has played its first match - ask an administrator to change the team logo';
  end if;
  return new;
end;
$$;
