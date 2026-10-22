-- Which tournament an official game belonged to, kept on the participation row itself.
--
-- match_participants already says WHETHER a game was official. The /official page also wants a board
-- per tournament, and the only link from a game to its event ran through match_reports
-- (tournament_match_id -> tournament_matches.tournament_id). That link does not last: recaps are
-- deleted after 30 days, and deleting a cancelled or test event deletes its bracket matches. The stats
-- row is the part of a game that is kept for good, so the event goes on it.
--
-- tournament_id is the event row the game was played in - the DIVISION, when an event was split. The
-- page groups divisions under the event they were split from (division_of), so the finer id is the
-- one worth keeping.
--
-- No foreign key, on purpose, exactly like match_reports.tournament_match_id: deleting an event must
-- never reach into the record of games that were played. A deleted event's games keep their id and
-- simply have no event to be listed under; they still count on the all-time board.

alter table public.match_participants add column if not exists tournament_id uuid;

comment on column public.match_participants.tournament_id is
  'The event (division) an official game was played in. Set by participant_official on insert; null for every non-official game. No foreign key: deleting an event never touches the games played in it.';

create index if not exists match_participants_tournament_idx
  on public.match_participants (tournament_id) where tournament_id is not null;

-- Stamped at the moment the row is written, alongside `official`, from the report written just before it.
create or replace function public.participant_official()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event uuid;
begin
  select m.tournament_id into v_event
    from match_reports r
    left join tournament_matches m on m.id = r.tournament_match_id
   where r.match_key = new.match_key and r.official
   limit 1;
  new.official := found;
  new.tournament_id := v_event;
  return new;
end;
$$;

-- Every official game already played, while its report and bracket match are still there to say which
-- event it was.
update public.match_participants mp
   set tournament_id = m.tournament_id
  from public.match_reports r
  join public.tournament_matches m on m.id = r.tournament_match_id
 where r.match_key = mp.match_key
   and r.official
   and mp.official
   and mp.tournament_id is null;
