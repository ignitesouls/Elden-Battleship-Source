-- The invitation inbox: "you've been invited to join <team> for <event>".
--
-- An invited player can read their invitation, but not the team that sent it: a team that is still
-- pending is visible only to its captain, its roster and the admins (the "entrants select" policy), and
-- an invitee is none of those until they accept. That is right for the team - a captain reworking a
-- name should not be published - and it leaves the invitee looking at an invitation with nobody's name
-- on it. Loosening the policy would expose every pending team to every invitee; the invitation itself
-- is the only thing they should be able to learn from.
--
-- So the inbox is a function, not a policy: it returns exactly the fields needed to decide - the event,
-- the team's name, who is captaining it, how full it is - for the caller's own pending invitations, and
-- nothing else about any team. Only invitations that can still be accepted are listed: an invitation to
-- an event whose signup has closed is dead and would only be a button that fails.

create or replace function public.my_roster_invites()
returns table (
  invite_id       uuid,
  tournament_id   uuid,
  tournament_name text,
  team_name       text,
  captain_name    text,
  team_size       int,
  roster_count    int,
  max_roster      int
)
language sql
stable
security definer
set search_path = public
as $$
  select i.id,
         t.id,
         t.name,
         e.name,
         (select r.display_name from tournament_roster r where r.entrant_id = e.id and r.is_captain limit 1),
         t.team_size,
         (select count(*)::int from tournament_roster r where r.entrant_id = e.id),
         t.max_roster
    from tournament_invites i
    join tournament_entrants e on e.id = i.entrant_id
    join tournaments t on t.id = e.tournament_id
   where i.status = 'pending'
     and i.twitch_login = public.my_twitch_login()
     and e.status in ('pending', 'approved')
     and public.tournament_signup_open(t.id)
   order by i.created_at;
$$;

grant execute on function public.my_roster_invites() to authenticated;
