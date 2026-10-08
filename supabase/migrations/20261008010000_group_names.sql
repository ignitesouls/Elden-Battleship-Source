-- Group names.
--
-- A group stage's groups were always "Group A", "Group B" ... worked out from their position. An
-- administrator can now name them - typed, or picked from the app's lists of names - and the name is
-- shown wherever the group is: the standings tables, the schedule.
--
-- One array on the event, by group number: group_names[1] names group 0 (Postgres arrays count from 1,
-- the app's groups from 0). An empty string, or no entry at all, means "use the letter" - so an event
-- that never names its groups needs nothing stored, and naming only some of them is fine.
--
-- Not part of `format`: the format is locked once the event is live (guard_tournament_update), and a
-- group's name is a label, not a rule - an organiser should be able to change it on day twenty. So it is
-- its own column, editable by an administrator in any state, like the description.

-- The rule for a list of names, in one place: at most 32 (more groups than any event will have), each
-- one empty or 1-40 characters with no padding, and no two the same - two groups called "Limgrave" would
-- make the standings unreadable. Immutable so a check constraint may call it.
create or replace function public.group_names_ok(p_names text[])
returns boolean
language sql
immutable
as $$
  select coalesce(cardinality(p_names), 0) <= 32
     and not exists (
       select 1 from unnest(p_names) n
        where n is null or char_length(n) > 40 or n <> btrim(n)
     )
     and (
       select count(*) = count(distinct lower(n)) from unnest(p_names) n where n <> ''
     );
$$;

alter table public.tournaments add column if not exists group_names text[] not null default '{}';

alter table public.tournaments drop constraint if exists tournaments_group_names_check;
alter table public.tournaments add constraint tournaments_group_names_check check (public.group_names_ok(group_names));

comment on column public.tournaments.group_names is
  'Names of the group stage''s groups by group number (element 1 = group 0); empty or missing = "Group A", "Group B"...';
