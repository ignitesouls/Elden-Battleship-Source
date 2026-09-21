-- An event finishes itself when its last match is decided, and reopens if that result is corrected.
--
-- Until now `finished` was a status an administrator set by hand. Over a month there is a real gap
-- between "the final was played" and someone remembering to click, and the event page reads as
-- unfinished for all of it. So finishing is derived from the bracket: the database looks at the event's
-- format and its matches, and moves the status itself.
--
-- -- What "complete" means ----------------------------------------------------------------------------
-- It is not simply "nothing left to play", because for most formats that is true at moments when the
-- event is nowhere near done:
--   * Swiss draws one round at a time, so after every round there is nothing left to play. The event
--     is complete only once as many rounds have been drawn as the format calls for.
--   * A qualifier followed by a knockout has nothing left to play the moment the qualifier ends, and
--     the knockout does not exist yet. The event is complete only once the knockout exists and is
--     finished - so the format has to be read, not just the matches.
-- Hence tournament_is_complete() takes the format from the tournament row. It mirrors
-- tournamentComplete() in src/lib/tournament/complete.ts and is checked against it.
--
-- -- Who finished it ---------------------------------------------------------------------------------
-- An administrator can still mark an event finished by hand - ending it early, say, with matches
-- unplayed. That must never be undone behind their back, so the database remembers who finished it
-- (finished_by_bracket). Only an event the BRACKET finished is reopened when a result is corrected;
-- one an admin finished stays finished until an admin says otherwise.
--
-- -- Why a trigger and not a call in each function ---------------------------------------------------
-- Results reach tournament_matches by several routes - the admin's score entry, a forfeit, a team
-- being removed, and (soon) archive_match feeding in an official game. A check called from each would
-- be one route short the day someone adds a fifth. A trigger on the table sees them all.

alter table public.tournaments add column if not exists finished_at timestamptz;
alter table public.tournaments add column if not exists champion_id uuid references public.tournament_entrants(id) on delete set null;
alter table public.tournaments add column if not exists finished_by_bracket boolean not null default false;

comment on column public.tournaments.finished_by_bracket is
  'True when the event became finished because its bracket completed, rather than because an administrator set it. Only such an event is reopened automatically when a result is corrected.';
comment on column public.tournaments.champion_id is
  'The winner of the knockout, recorded when the bracket finishes the event. Null for an event with no knockout (its table decides), and for one an administrator finished by hand.';

-- -- Bookkeeping when the status changes --------------------------------------------------------------
-- A status change that did not also touch finished_by_bracket is a HUMAN one (the bracket's own
-- changes always set the two together), so it clears the flag: an admin finishing or reopening an event
-- takes it out of the bracket's hands.
create or replace function public.tournament_finish_bookkeeping()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from old.status
     and new.finished_by_bracket is not distinct from old.finished_by_bracket then
    new.finished_by_bracket := false;
  end if;

  if new.status = 'finished' and old.status is distinct from 'finished' then
    new.finished_at := now();
  elsif old.status = 'finished' and new.status <> 'finished' then
    new.finished_at := null;
    new.champion_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists tournaments_finish_bookkeeping on public.tournaments;
create trigger tournaments_finish_bookkeeping
  before update on public.tournaments
  for each row execute function public.tournament_finish_bookkeeping();

-- -- Is the bracket complete? --------------------------------------------------------------------------
create or replace function public.tournament_is_complete(p_tournament uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  f jsonb;
  has_knockout boolean;
  qualifier text;
  rounds_needed int;
  drawn int;
begin
  select t.format into f from tournaments t where t.id = p_tournament;
  if f is null then
    return false;
  end if;

  has_knockout := coalesce(jsonb_typeof(f -> 'knockout') = 'object', false);
  qualifier := f -> 'qualifier' ->> 'format';

  if has_knockout then
    -- The knockout has to exist (it is built after the qualifier) and have nothing left open. A
    -- skipped grand-final reset is not open; an undecided one is.
    return exists (select 1 from tournament_matches m where m.tournament_id = p_tournament and m.stage = 'knockout')
       and not exists (
         select 1 from tournament_matches m
          where m.tournament_id = p_tournament and m.stage = 'knockout'
            and m.status in ('pending', 'ready', 'in_progress')
       );
  end if;

  if qualifier = 'swiss' then
    rounds_needed := coalesce((f -> 'qualifier' ->> 'rounds')::int, 0);
    select coalesce(max(m.round), 0) into drawn from tournament_matches m
     where m.tournament_id = p_tournament and m.stage = 'swiss';
    return rounds_needed > 0 and drawn >= rounds_needed
       and not exists (
         select 1 from tournament_matches m
          where m.tournament_id = p_tournament and m.stage = 'swiss'
            and m.status in ('pending', 'ready', 'in_progress')
       );
  end if;

  if qualifier = 'groups' then
    return exists (select 1 from tournament_matches m where m.tournament_id = p_tournament and m.stage = 'group')
       and not exists (
         select 1 from tournament_matches m
          where m.tournament_id = p_tournament and m.stage = 'group'
            and m.status in ('pending', 'ready', 'in_progress')
       );
  end if;

  return false;
end;
$$;

-- -- Who won the knockout ------------------------------------------------------------------------------
-- Mirrors knockoutChampion() in bracket.ts. With a grand final, the reset decides it if there is one
-- and it was needed; otherwise the grand final does. Without one, the winners-bracket final does.
create or replace function public.tournament_champion(p_tournament uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  gf1 tournament_matches%rowtype;
  rst tournament_matches%rowtype;
  final_winner uuid;
begin
  select * into gf1 from tournament_matches m
   where m.tournament_id = p_tournament and m.stage = 'knockout' and m.key = 'GF1';
  if found then
    select * into rst from tournament_matches m
     where m.tournament_id = p_tournament and m.stage = 'knockout' and m.reset_of = 'GF1';
    if found and rst.status <> 'skipped' then
      return rst.winner;
    end if;
    return gf1.winner;
  end if;

  select m.winner into final_winner from tournament_matches m
   where m.tournament_id = p_tournament and m.stage = 'knockout' and m.bracket = 'W'
   order by m.round desc, m.idx limit 1;
  return final_winner;
end;
$$;

-- -- Move the status --------------------------------------------------------------------------------
create or replace function public.tournament_sync_finished(p_tournament uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t tournaments%rowtype;
  complete boolean;
  champ uuid;
begin
  select * into t from tournaments where id = p_tournament for update;
  if not found then
    return;
  end if;
  -- Only a running event can be finished by its bracket, and only one the bracket finished can be
  -- reopened by it. Drafts, open signups and cancelled events are none of its business, and neither
  -- is an event an administrator finished by hand.
  if t.status not in ('live', 'finished') then
    return;
  end if;
  if t.status = 'finished' and not t.finished_by_bracket then
    return;
  end if;

  complete := public.tournament_is_complete(p_tournament);
  champ := case when complete and coalesce(jsonb_typeof(t.format -> 'knockout') = 'object', false)
                then public.tournament_champion(p_tournament) end;

  if complete and t.status = 'live' then
    update tournaments
       set status = 'finished', finished_by_bracket = true, champion_id = champ
     where id = p_tournament;
  elsif complete and t.status = 'finished' then
    -- Still finished, but a correction may have changed who won.
    update tournaments set champion_id = champ where id = p_tournament and champion_id is distinct from champ;
  elsif not complete and t.status = 'finished' then
    update tournaments set status = 'live', finished_by_bracket = false where id = p_tournament;
  end if;
end;
$$;

revoke all on function public.tournament_sync_finished(uuid) from public, anon, authenticated;

-- -- The trigger ----------------------------------------------------------------------------------------
create or replace function public.tournament_matches_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Completeness moves with a match's status, and the champion moves with the winner: correcting the
  -- final from 1-0 to 0-1 leaves it 'done' the whole time but changes who won the event. Anything
  -- else - a time, a score that leaves the winner alone - cannot affect either.
  if tg_op = 'UPDATE' and new.status = old.status and new.winner is not distinct from old.winner then
    return null;
  end if;
  perform public.tournament_sync_finished(new.tournament_id);
  return null;
end;
$$;

drop trigger if exists tournament_matches_sync_finished on public.tournament_matches;
create trigger tournament_matches_sync_finished
  after insert or update on public.tournament_matches
  for each row execute function public.tournament_matches_changed();
