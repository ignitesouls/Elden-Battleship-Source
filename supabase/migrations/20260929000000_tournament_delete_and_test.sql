-- Deleting a cancelled event, and test events for trying the admin controls.
--
-- -- Deleting ----------------------------------------------------------------------------------------
-- A cancelled event used to stay on the admin list for good. It can now be deleted, along with its
-- teams, rosters, entry codes and bracket. What it does NOT take with it is the record of games played:
-- an official game that finished inside the event stays official on the players' careers and the
-- Official leaderboard (match_reports and match_participants hold no reference that a delete follows).
-- The games happened; the event is only being tidied off the list.
--
-- Deleting is one function rather than a bare DELETE, for two reasons:
--   * The bracket of a cancelled event is frozen (guard_matches_when_cancelled refuses every INSERT or
--     UPDATE on its matches). Deleting the event's teams sets their places in the bracket to null,
--     which is an UPDATE, and the freeze could refuse it half-way through the cascade. Deleting the
--     matches first - a DELETE, which the freeze does not guard - leaves nothing for the cascade to
--     update.
--   * Which events may be deleted is a rule: a draft (nothing happened yet), a cancelled event, or a
--     test event in any state. A live or finished event is never deleted - cancel it first. The direct
--     DELETE policy now says the same, so there is no second door.
--
-- -- Test events -------------------------------------------------------------------------------------
-- An administrator can make a test event: a real event, run by the real controls, filled with made-up
-- teams, and invisible to everyone but administrators whatever state it is in. It exists so the desk
-- can be tried - start it, enter scores, forfeit, substitute, draw rounds, cancel, delete - without an
-- event anyone can see.
--   * Made-up players are just ids with no account behind them (tournament_roster.user_id and
--     captain_user_id have no foreign key). Nobody can sign in as one, so no official match can be
--     played in a test event - results go in by score entry on the desk.
--   * It never turns on the Official stat category (official_stats_enabled ignores it), never shows on
--     the front page, and is never offered as an event in the official-match lobby (the app filters it;
--     and with no real player on any roster a room could never start one anyway).
--   * is_test is fixed at creation. A real event can't be turned into a test one (which would hide it
--     and make it deletable), and a test event can't be made public.

alter table public.tournaments add column if not exists is_test boolean not null default false;

comment on column public.tournaments.is_test is
  'A test event for trying the admin controls: made-up teams, visible to administrators only, deletable in any state. Fixed at creation.';

-- -- Only administrators see a test event --------------------------------------------------------------
drop policy if exists "tournaments select" on public.tournaments;
create policy "tournaments select" on public.tournaments for select
  using ((status <> 'draft' and not is_test) or public.is_admin());

create or replace function public.tournament_visible(p_tournament uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
      or exists (select 1 from tournaments t where t.id = p_tournament and t.status <> 'draft' and not t.is_test);
$$;

create or replace function public.official_stats_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from tournaments t where t.went_live_at is not null and not t.is_test);
$$;

-- -- is_test is fixed at creation ------------------------------------------------------------------------
create or replace function public.guard_tournament_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.is_service_session() then
    return new;
  end if;
  if new.is_test is distinct from old.is_test then
    raise exception 'Whether an event is a test event is fixed when it is created';
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

-- -- Deleting ------------------------------------------------------------------------------------------
drop policy if exists "tournaments delete by admin" on public.tournaments;
create policy "tournaments delete by admin" on public.tournaments for delete
  using (public.is_admin() and (is_test or status in ('draft', 'cancelled')));

create or replace function public.delete_tournament(p_tournament uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t tournaments%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can delete an event';
  end if;

  select * into t from tournaments where id = p_tournament for update;
  if not found then
    raise exception 'There is no such event';
  end if;
  if not t.is_test and t.status not in ('draft', 'cancelled') then
    raise exception 'Only a draft or a cancelled event can be deleted - cancel it first';
  end if;

  -- The bracket first: see the header. A room still linked to one of these matches is unlinked by the
  -- foreign key (on delete set null) and simply stops being official.
  delete from tournament_matches where tournament_id = p_tournament;
  delete from tournaments where id = p_tournament;
end;
$$;

grant execute on function public.delete_tournament(uuid) to authenticated;

-- -- Making a test event ---------------------------------------------------------------------------------
-- Opens straight into signup with every team approved (and so holding an entry code), which puts
-- "Start the event" one click away. Each roster has one place to spare, so a substitution can be tried.
create or replace function public.create_test_tournament(p_name text, p_teams int, p_team_size int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
  eid uuid;
  captain uuid;
  label text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can make a test event';
  end if;
  if p_teams is null or p_teams < 2 or p_teams > 64 then
    raise exception 'A test event needs between 2 and 64 teams';
  end if;
  if p_team_size is null or p_team_size < 1 or p_team_size > 10 then
    raise exception 'A team has between 1 and 10 players';
  end if;

  insert into tournaments (name, description, status, team_size, max_roster, is_test)
  values (
    coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'Test event'),
    'A test event: made-up teams, visible to administrators only.',
    'signup', p_team_size, p_team_size + 1, true)
  returning id into tid;

  for i in 1 .. p_teams loop
    label := case when p_team_size = 1 then 'Tester ' || i else 'Test Team ' || i end;
    captain := gen_random_uuid();
    insert into tournament_entrants (tournament_id, name, captain_user_id)
    values (tid, label, captain)
    returning id into eid;

    -- The captain's roster row was written by tournament_entrants_created, under a placeholder name.
    update tournament_roster
       set display_name = case when p_team_size = 1 then label else 'Tester ' || i || '-1' end
     where entrant_id = eid and user_id = captain;
    for j in 2 .. p_team_size loop
      insert into tournament_roster (entrant_id, user_id, display_name)
      values (eid, gen_random_uuid(), 'Tester ' || i || '-' || j);
    end loop;

    -- Pending, then approved, the way a real team gets there - approving is what issues the entry code.
    update tournament_entrants set status = 'approved' where id = eid;
  end loop;

  return tid;
end;
$$;

grant execute on function public.create_test_tournament(text, int, int) to authenticated;
