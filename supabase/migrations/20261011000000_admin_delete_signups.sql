-- Administrators deleting signups: a team (or, in an individual event, a player) and a solo player
-- waiting in the free-agent pool.
--
-- Rejecting a team keeps it on the admin list and lets the admin change their mind; deleting is for
-- when it should simply not be there - a joke team, a duplicate, a test signup. It is a real delete:
-- the team's roster, invitations and entry code go with it (all cascade from tournament_entrants),
-- and nothing stops the same players signing up again.
--
-- A team the admin built from the pool takes its pool players with it. They signed up solo and were
-- placed on that team; deleting it deletes their pool rows too, rather than putting them back to wait
-- (which is what rejecting does). Players who joined the team any other way have no pool row to delete.
--
-- Only before the event starts - while it is a draft or in signup, open or closed. Once it is live the
-- team is in the bracket, and taking it out is a forfeit (forfeit_team), which the desk already does.
-- The team's logo files are not touched here: storage files are removed by the app, after the delete,
-- the same way delete_tournament leaves them to it.

create or replace function public.admin_delete_entrant(p_entrant uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
  t_status text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can delete a team';
  end if;

  select e.tournament_id into tid from tournament_entrants e where e.id = p_entrant for update;
  if not found then
    raise exception 'There is no such team';
  end if;
  select t.status into t_status from tournaments t where t.id = tid;
  if t_status not in ('draft', 'signup') then
    raise exception 'Teams can only be deleted before the event starts - forfeit the team instead';
  end if;

  -- Its pool players first: once the team row is gone their placed_entrant_id would be nulled by the
  -- foreign key, and they could no longer be told apart from anyone else.
  delete from tournament_free_agents where placed_entrant_id = p_entrant;
  delete from tournament_entrants where id = p_entrant;
end;
$$;

grant execute on function public.admin_delete_entrant(uuid) to authenticated;

create or replace function public.admin_delete_free_agent(p_free_agent uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
  fa_status text;
  t_status text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can delete a solo signup';
  end if;

  select fa.tournament_id, fa.status into tid, fa_status
    from tournament_free_agents fa where fa.id = p_free_agent for update;
  if not found then
    raise exception 'There is no such solo signup';
  end if;
  -- A placed player is on a team: take them off its roster (they wait again), or delete the team.
  if fa_status = 'placed' then
    raise exception 'That player is on a team - take them off the roster first';
  end if;
  select t.status into t_status from tournaments t where t.id = tid;
  if t_status not in ('draft', 'signup') then
    raise exception 'Solo signups can only be deleted before the event starts';
  end if;

  delete from tournament_free_agents where id = p_free_agent;
end;
$$;

grant execute on function public.admin_delete_free_agent(uuid) to authenticated;
