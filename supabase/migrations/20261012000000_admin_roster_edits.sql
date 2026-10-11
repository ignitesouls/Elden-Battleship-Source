-- Administrators adding and removing players on a team before the event starts.
--
-- A teammate joins by accepting an invitation, and some players never find the button: they aren't
-- signed in with Twitch when they look, or they look on the wrong page. Their captain asks in Discord,
-- and until now the only fix was a substitution - which needs someone to swap OUT, and is only offered
-- once signup is under way. These are the direct versions: put a named player on the roster, or take
-- one off, without a replacement.
--
-- Adding skips the invitee's consent, which invitations exist to ask for (see invite_to_roster). That
-- is fine for an administrator: they act on what the player said in Discord, the same way
-- substitute_player already does. An invitation to the same team that was waiting is marked accepted,
-- so the player isn't left with a button that would now fail.
--
-- Only before the event starts - draft or signup, open or closed. Once it is live the desk's
-- substitution and pool placement cover roster changes, and events run with no subs.
--
-- Removing never takes the captain: a team needs one, so the captaincy is handed on first
-- (hand_over_tournament_captaincy, below, now allowed in a draft too). A player who came from the solo
-- pool goes back to waiting there - that is the existing roster trigger, free_agent_released_by_roster.

create or replace function public.admin_add_to_roster(p_entrant uuid, p_login text)
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
  in_id uuid;
  in_name text;
  in_login text := public.normalize_twitch_login(p_login);
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can add a player to a team';
  end if;

  select e.tournament_id, e.status into tid, e_status from tournament_entrants e where e.id = p_entrant for update;
  if tid is null then
    raise exception 'There is no such team';
  end if;
  if e_status not in ('pending', 'approved') then
    raise exception 'That team is not taking players';
  end if;
  select t.status, t.max_roster into t_status, cap from tournaments t where t.id = tid;
  if t_status not in ('draft', 'signup') then
    raise exception 'Players can only be added before the event starts - substitute instead';
  end if;

  if in_login = '' then
    raise exception 'Type the player''s Twitch username';
  end if;
  select p.id, p.display_name into in_id, in_name from profiles p where lower(p.twitch_login) = in_login;
  if in_id is null then
    raise exception 'Nobody with the Twitch name "%" has signed in on this site yet', in_login;
  end if;
  if exists (select 1 from tournament_roster r where r.entrant_id = p_entrant and r.user_id = in_id) then
    raise exception '% is already on this team', in_login;
  end if;
  if exists (
    select 1
      from tournament_roster r
      join tournament_entrants e on e.id = r.entrant_id
     where r.user_id = in_id and e.tournament_id = tid and e.status in ('pending', 'approved')
  ) then
    raise exception '% is already on another team in this event', in_login;
  end if;
  if (select count(*) from tournament_roster r where r.entrant_id = p_entrant) >= cap then
    raise exception 'That team is full (% players)', cap;
  end if;

  insert into tournament_roster (entrant_id, user_id, display_name)
  values (p_entrant, in_id, coalesce(in_name, in_login));
  update tournament_invites set status = 'accepted'
   where entrant_id = p_entrant and twitch_login = in_login and status = 'pending';
end;
$$;

grant execute on function public.admin_add_to_roster(uuid, text) to authenticated;

create or replace function public.admin_remove_from_roster(p_entrant uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
  t_status text;
  was_captain boolean;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can remove a player from a team';
  end if;

  select e.tournament_id into tid from tournament_entrants e where e.id = p_entrant for update;
  if tid is null then
    raise exception 'There is no such team';
  end if;
  select t.status into t_status from tournaments t where t.id = tid;
  if t_status not in ('draft', 'signup') then
    raise exception 'Players can only be removed before the event starts - substitute instead';
  end if;

  select r.is_captain into was_captain from tournament_roster r where r.entrant_id = p_entrant and r.user_id = p_user;
  if was_captain is null then
    raise exception 'That player is not on this team';
  end if;
  if was_captain then
    raise exception 'The captain cannot be removed - make someone else captain first, or delete the team';
  end if;

  delete from tournament_roster where entrant_id = p_entrant and user_id = p_user;
end;
$$;

grant execute on function public.admin_remove_from_roster(uuid, uuid) to authenticated;

-- Handing on a captaincy is now allowed in a draft as well, so the signup card's "Make captain" works
-- on an event that hasn't opened yet. Reproduced in full; the change is the status test.
create or replace function public.hand_over_tournament_captaincy(p_entrant uuid, p_new_captain uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
  e_status text;
  t_status text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can change a team''s captain';
  end if;

  select e.tournament_id, e.status into tid, e_status from tournament_entrants e where e.id = p_entrant;
  if tid is null then
    raise exception 'There is no such team';
  end if;
  if e_status not in ('pending', 'approved') then
    raise exception 'That team is not in the event';
  end if;
  select t.status into t_status from tournaments t where t.id = tid;
  if t_status not in ('draft', 'signup', 'live') then
    raise exception 'Captains can only be changed while an event is being set up, taking signups or running';
  end if;
  if not exists (select 1 from tournament_roster r where r.entrant_id = p_entrant and r.user_id = p_new_captain) then
    raise exception 'The new captain has to be on the team already';
  end if;
  if exists (select 1 from tournament_roster r where r.entrant_id = p_entrant and r.user_id = p_new_captain and r.is_captain) then
    raise exception 'That player is already the captain';
  end if;

  update tournament_roster set is_captain = (user_id = p_new_captain) where entrant_id = p_entrant;
  update tournament_entrants set captain_user_id = p_new_captain where id = p_entrant;
end;
$$;
