-- Divisions: one tournament split into separate events, each with its own teams, format, schedule,
-- playoffs and champion.
--
-- An organizer with sixteen signups may want the ten strongest teams in an upper division and the six
-- newest in a lower one, playing completely apart - not a challenger group inside one event, whose
-- qualifiers still meet everyone else in the knockout. The simplest thing that is completely apart is
-- two events, so that is what a division is: split_division() makes a new event, linked to the one it
-- came from, and moves the teams the organizer picked into it. Everything an event already does - the
-- plan page, groups, weeks, the desk, standings, Crew Quarters - then works on each division unchanged.
--
-- division_of points at the event the division was split from (the first event of the tournament; a
-- second split from either division still points there), and division_name is the label the event
-- pages show in the switcher between divisions ("Upper Division", "Lower Division"). An event that was
-- never split has neither and looks exactly as before.
--
-- Only before the event starts: draft or signup. No matches exist then, so a team is moved by changing
-- which event it belongs to - its roster and invitations hang off the team and follow it. Its entry code
-- carries the event too, and so does a solo player's pool entry once they are placed on a team.

alter table public.tournaments add column if not exists division_of uuid references public.tournaments(id) on delete set null;
alter table public.tournaments add column if not exists division_name text not null default '';
alter table public.tournaments drop constraint if exists tournaments_division_name_len;
alter table public.tournaments add constraint tournaments_division_name_len check (char_length(division_name) <= 40);

create index if not exists tournaments_division_of_idx on public.tournaments (division_of) where division_of is not null;

create or replace function public.split_division(
  p_event uuid,
  p_entrants uuid[],
  p_name text,
  p_this_label text,
  p_new_label text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  src tournaments%rowtype;
  new_id uuid;
  staying int;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can split off a division';
  end if;

  select * into src from tournaments where id = p_event for update;
  if not found then
    raise exception 'There is no such event';
  end if;
  if src.status not in ('draft', 'signup') then
    raise exception 'A division can only be split off before the event starts';
  end if;
  if coalesce(array_length(p_entrants, 1), 0) = 0 then
    raise exception 'Pick the teams that go in the new division';
  end if;
  if exists (
    select 1 from unnest(p_entrants) as x(id)
     where not exists (select 1 from tournament_entrants e where e.id = x.id and e.tournament_id = p_event)
  ) then
    raise exception 'A team you picked is not in this event';
  end if;
  select count(*) into staying
    from tournament_entrants e
   where e.tournament_id = p_event and e.status in ('pending', 'approved') and not (e.id = any(p_entrants));
  if staying = 0 then
    raise exception 'Leave at least one team in this event';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) < 3 then
    raise exception 'Give the new division a name';
  end if;

  -- The new event: the same kind of event, open on the same dates, played by the same rules. Not its
  -- logo (the file belongs to this event, and clearing one would break the other), its group names or
  -- its entry cap - those are the division's own to set.
  insert into tournaments (name, description, status, team_size, max_roster, signup_closes_at, starts_at,
                           match_settings, is_test, extra_rules, division_of, division_name)
  values (btrim(p_name), src.description, src.status, src.team_size, src.max_roster, src.signup_closes_at, src.starts_at,
          src.match_settings, src.is_test, src.extra_rules, coalesce(src.division_of, src.id), btrim(coalesce(p_new_label, '')))
  returning id into new_id;

  if btrim(coalesce(p_this_label, '')) <> '' then
    update tournaments set division_name = btrim(p_this_label) where id = p_event;
  end if;

  update tournament_entrants set tournament_id = new_id where id = any(p_entrants);
  update tournament_entrant_secrets set tournament_id = new_id where entrant_id = any(p_entrants);
  update tournament_free_agents set tournament_id = new_id where placed_entrant_id = any(p_entrants);

  -- A plan in progress: the new division starts from a copy of it with only its own teams in the seed
  -- order, and this event's plan keeps the rest. The plan page fixes up anything else that no longer
  -- fits when it opens (hand placements of teams that left, a group count too big for the field).
  insert into tournament_plans (tournament_id, format, schedule, seed_order, fit_days)
  select new_id, p.format, p.schedule,
         array(select u.x from unnest(p.seed_order) with ordinality as u(x, n) where u.x = any(p_entrants) order by u.n),
         p.fit_days
    from tournament_plans p
   where p.tournament_id = p_event;
  update tournament_plans
     set seed_order = array(select u.x from unnest(seed_order) with ordinality as u(x, n) where not (u.x = any(p_entrants)) order by u.n)
   where tournament_id = p_event;

  return new_id;
end;
$$;

revoke all on function public.split_division(uuid, uuid[], text, text, text) from public, anon;
grant execute on function public.split_division(uuid, uuid[], text, text, text) to authenticated;

-- Renaming a division's label afterwards is an ordinary event edit by an administrator (the tournaments
-- update policy already allows it); nothing else needs a function.
