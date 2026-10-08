-- An event's plan, saved while signup is still open.
--
-- The start page used to hold everything in the browser until Start was pressed: the seed order, the
-- format, the schedule. An organiser who wanted to draft the groups a week early, come back, and adjust
-- as teams kept signing up had nowhere to keep that draft. Now the page saves it here, and opens from it.
--
-- A separate table, not more columns on `tournaments`, because an event's row is public while it takes
-- signups - and a half-made seeding is the organisers' working, not something for teams to read and
-- argue with before it is final. Administrators only, read and write.
--
-- Nothing here is the event's real format: start_tournament still takes the format, schedule and seeds
-- as arguments and writes them to the event, exactly as before. A plan is only where the page starts
-- from. Group names and official-match rules are not here: those already have homes on the event
-- (group_names, match_settings) that an administrator can write at any time.

create table if not exists public.tournament_plans (
  tournament_id uuid primary key references public.tournaments(id) on delete cascade,
  format        jsonb not null,
  schedule      jsonb not null,
  -- Team ids, best seed first. Teams that sign up after it was saved go on the end when the page opens;
  -- teams no longer in the event are dropped.
  seed_order    uuid[] not null default '{}',
  -- The "fit the event into about N days" box, so it reopens as it was left.
  fit_days      int,
  updated_at    timestamptz not null default now(),
  updated_by    uuid default auth.uid()
);

alter table public.tournament_plans enable row level security;

drop policy if exists "plans admin" on public.tournament_plans;
create policy "plans admin" on public.tournament_plans for all
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.touch_tournament_plan()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists tournament_plans_touch on public.tournament_plans;
create trigger tournament_plans_touch
  before insert or update on public.tournament_plans
  for each row execute function public.touch_tournament_plan();
