-- Rules an organiser adds to one event, on top of the shared rulebook.
--
-- The rulebook itself is not stored: it lives in the app (src/lib/tournament/rulebook.ts), shared by
-- every event, with each event's crew size, clock, board and format written in from the row. This
-- column is only what one event says beyond that - a house rule, a marking rule for an objectives
-- board, a Discord link - shown above the shared rules on the event's rules page, and taking precedence
-- over them.
--
-- Plain text, editable in any state: an organiser may need to clarify a rule mid-event, and nothing
-- built from the row depends on it. The existing admin-only update policy covers it, and the select
-- policy already makes it as public as the event itself.

alter table public.tournaments add column if not exists extra_rules text not null default '';

alter table public.tournaments drop constraint if exists tournaments_extra_rules_length;
alter table public.tournaments add constraint tournaments_extra_rules_length check (char_length(extra_rules) <= 20000);

comment on column public.tournaments.extra_rules is
  'Event-specific rules, shown above the shared rulebook on /event/<id>/rules and taking precedence over it.';
