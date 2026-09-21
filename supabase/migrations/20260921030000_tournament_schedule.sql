-- Running an event over weeks rather than an evening: round deadlines, forfeits, agreed match times,
-- an overdue list, and substitutions.
--
-- Everything before this assumed the whole bracket was played in one sitting. Over a month, matches
-- are played whenever two teams can find a time, and the organizers' problems change: a round can't
-- close until its last match is played, one absent team can stall the event, and players drop out or
-- need replacing. This migration is the schema half of handling that.
--
-- -- Deliberately manual -----------------------------------------------------------------------------
-- Deadlines are ADVISORY. Nothing is forfeited by a clock. A match past its due date is listed for the
-- admins (overdue_tournament_matches) and an admin decides - forfeit it, give the teams more time, or
-- leave it. Notifying people is likewise done by hand, in Discord; there is no webhook and no email,
-- and the site collects nothing it would need to send one. The reasoning is that a silent automatic
-- forfeit can decide someone's month on a technicality, and a hand-off costs an admin one click.
--
-- What the database DOES do on its own is follow through on a decision already made: once an admin has
-- removed a team from the event, every match that team is put into is forfeited as it becomes ready
-- (tournament_settle_forfeits), so a departed team can never stall a bracket by having an opponent
-- wait for it. That mirrors settleForfeits() in src/lib/tournament/bracket.ts, and like
-- tournament_apply_score it is checked against the TypeScript by scripts/check-tournament-sql.ts.

-- ===========================================================================
--  Columns
-- ===========================================================================

-- The schedule is the organizer's plan (start date, days per round, overrides); it lives apart from
-- `format` because format is locked once the event is live and a schedule has to keep moving.
alter table public.tournaments add column if not exists schedule jsonb not null default '{}'::jsonb;

-- `phase` is the stage's own notion of "round": the Swiss round, the group matchday, or - for a
-- knockout, where the winners and loser brackets run side by side - how many results deep the match
-- sits (see assignPhases in src/lib/tournament/schedule.ts). A deadline belongs to a phase.
alter table public.tournament_matches add column if not exists phase int;
alter table public.tournament_matches add column if not exists opens_at timestamptz;
alter table public.tournament_matches add column if not exists due_at timestamptz;
-- When the two teams have said they will play. Informational; shown on the bracket for casters.
alter table public.tournament_matches add column if not exists agreed_at timestamptz;
alter table public.tournament_matches add column if not exists agreed_by uuid;
-- How a decided match was decided: an official game ('played'), an administrator entering or
-- correcting a score ('admin'), or a forfeit. Standings treat all three alike - a win is a win - but
-- the bracket page and the record want to say which.
alter table public.tournament_matches add column if not exists result_kind text not null default 'played'
  check (result_kind in ('played', 'admin', 'forfeit'));

-- A team an administrator has removed from a running event. The row stays - it is on the record and
-- in the bracket - but everything it is still due to play is forfeited.
alter table public.tournament_entrants add column if not exists forfeited_at timestamptz;

update public.tournament_matches set phase = round where phase is null;

-- ===========================================================================
--  The entrant guard, extended
-- ===========================================================================
-- Reproduced in full (create or replace cannot patch a body). The one change is that forfeited_at is
-- an administrator's to set or clear: a captain who could write it could walk their team out of the
-- bracket without the admin ever deciding to, or - worse - reinstate a team the admin had removed.
create or replace function public.guard_tournament_entrant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cap int;
  taken int;
begin
  if public.is_service_session() or public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.forfeited_at is not null then
      raise exception 'Only an administrator can change that';
    end if;

    select t.max_entrants into cap from tournaments t where t.id = new.tournament_id;
    select count(*) into taken from tournament_entrants e
     where e.tournament_id = new.tournament_id and e.status in ('pending', 'approved');
    if cap is not null and taken >= cap then
      raise exception 'This event is full';
    end if;

    if exists (
      select 1
        from tournament_roster r
        join tournament_entrants e on e.id = r.entrant_id
       where r.user_id = new.captain_user_id
         and e.tournament_id = new.tournament_id
         and e.status in ('pending', 'approved')
    ) then
      raise exception 'You are already on a team in this event';
    end if;
    return new;
  end if;

  -- UPDATE, by a captain. They may rename the team while signup is open, or withdraw it.
  if new.tournament_id is distinct from old.tournament_id
     or new.captain_user_id is distinct from old.captain_user_id
     or new.seed is distinct from old.seed
     or new.forfeited_at is distinct from old.forfeited_at then
    raise exception 'Only an administrator can change that';
  end if;

  if new.status is distinct from old.status then
    if new.status <> 'withdrawn' then
      raise exception 'Only an administrator can approve or reject a team';
    end if;
    -- Once the event is running the team is in the bracket, and pulling it out is a decision about
    -- everyone it is scheduled to play - an administrator's, not the captain's.
    if not public.tournament_signup_open(old.tournament_id) then
      raise exception 'Signup has closed - ask an administrator to withdraw the team';
    end if;
    return new;
  end if;

  if new.name is distinct from old.name and not public.tournament_signup_open(old.tournament_id) then
    raise exception 'Signup has closed - ask an administrator to change the team name';
  end if;
  return new;
end;
$$;

-- ===========================================================================
--  Forfeits
-- ===========================================================================
-- A forfeit awards the match to the other side with a winning score and no games against - 2-0 in a
-- best of three - so it flows through tournament_apply_score like any result and the bracket advances
-- by the same rules. What marks it as a forfeit is result_kind, not the score.

create or replace function public.tournament_forfeit_match(p_match uuid, p_loser text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m    tournament_matches%rowtype;
  need int;
begin
  select * into m from tournament_matches where id = p_match;
  if not found then
    raise exception 'There is no such tournament match';
  end if;
  if p_loser not in ('a', 'b') then
    raise exception 'The forfeiting side must be a or b';
  end if;
  if m.entrant_a is null or m.entrant_b is null then
    raise exception '% is still waiting on earlier results', m.key;
  end if;
  -- A match that already has a winner is not forfeited: correcting a played result is a score
  -- entry, and reverting is its own action. Otherwise a forfeit would quietly rewrite history.
  if m.winner is not null then
    raise exception '% is already decided', m.key;
  end if;

  need := m.best_of / 2 + 1;
  perform public.tournament_apply_score(
    p_match,
    case when p_loser = 'a' then 0 else need end,
    case when p_loser = 'b' then 0 else need end);
  update tournament_matches set result_kind = 'forfeit' where id = p_match;
end;
$$;

revoke all on function public.tournament_forfeit_match(uuid, text) from public, anon, authenticated;

-- Forfeits every open match that has a removed team in it, and keeps going: awarding one match places
-- its winner and loser into the next, which may be another match with a removed team in it (a team
-- dropping into the loser bracket, say). It stops when there is nothing left to do, which it always
-- reaches, since each pass decides a match. If both sides have been removed the first-listed side
-- forfeits - somebody has to advance, and the removed team it meets next forfeits in turn.
create or replace function public.tournament_settle_forfeits(p_tournament uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m tournament_matches%rowtype;
  loser text;
begin
  loop
    select mm.* into m
      from tournament_matches mm
     where mm.tournament_id = p_tournament
       and mm.status in ('ready', 'in_progress')
       and exists (
         select 1 from tournament_entrants e
          where e.id in (mm.entrant_a, mm.entrant_b) and e.forfeited_at is not null
       )
     order by mm.round, mm.idx, mm.key
     limit 1;
    exit when not found;

    loser := case
      when exists (select 1 from tournament_entrants e where e.id = m.entrant_a and e.forfeited_at is not null)
        then 'a' else 'b' end;
    perform public.tournament_forfeit_match(m.id, loser);
  end loop;
end;
$$;

revoke all on function public.tournament_settle_forfeits(uuid) from public, anon, authenticated;

-- Admin: forfeit one match - the no-show, the walkover.
create or replace function public.forfeit_tournament_match(p_match uuid, p_loser text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can forfeit a match';
  end if;
  select m.tournament_id into tid from tournament_matches m where m.id = p_match;
  if tid is null then
    raise exception 'There is no such tournament match';
  end if;
  perform public.tournament_forfeit_match(p_match, p_loser);
  perform public.tournament_settle_forfeits(tid);
end;
$$;

grant execute on function public.forfeit_tournament_match(uuid, text) to authenticated;

-- Admin: take a team out of a running event. Everything it is due to play is forfeited, now and as
-- it becomes ready. To bring it back, clear entrants.forfeited_at - the forfeits already recorded
-- stay as results, and an admin reverts any that should not stand.
create or replace function public.forfeit_team(p_entrant uuid)
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
    raise exception 'Only an administrator can remove a team from an event';
  end if;
  select e.tournament_id, e.status into tid, e_status from tournament_entrants e where e.id = p_entrant;
  if tid is null then
    raise exception 'There is no such team';
  end if;
  select t.status into t_status from tournaments t where t.id = tid;
  if t_status <> 'live' then
    raise exception 'Only a running event has matches to forfeit - reject or withdraw the team instead';
  end if;
  if e_status <> 'approved' then
    raise exception 'Only an approved team is in the bracket';
  end if;

  update tournament_entrants set forfeited_at = coalesce(forfeited_at, now()) where id = p_entrant;
  perform public.tournament_settle_forfeits(tid);
end;
$$;

grant execute on function public.forfeit_team(uuid) to authenticated;

-- ===========================================================================
--  The admin score functions, now recording how a result was reached
-- ===========================================================================
-- Both reproduced in full. The additions are result_kind, and settling forfeits afterwards: an
-- entered result can be the one that places a removed team into its next match.

create or replace function public.tournament_record_game(p_match uuid, p_side text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m tournament_matches%rowtype;
begin
  select * into m from tournament_matches where id = p_match;
  if not found then
    raise exception 'There is no such tournament match';
  end if;
  if m.winner is not null then
    raise exception '% is already decided', m.key;
  end if;
  perform public.tournament_apply_score(
    p_match,
    m.score_a + case when p_side = 'a' then 1 else 0 end,
    m.score_b + case when p_side = 'b' then 1 else 0 end);
  update tournament_matches set result_kind = 'played' where id = p_match;
  perform public.tournament_settle_forfeits(m.tournament_id);
end;
$$;

revoke all on function public.tournament_record_game(uuid, text) from public, anon, authenticated;

create or replace function public.set_tournament_match_score(p_match uuid, p_score_a int, p_score_b int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m tournament_matches%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can enter a result';
  end if;
  select * into m from tournament_matches where id = p_match;
  if found and p_score_a = 0 and p_score_b = 0 and m.score_a + m.score_b = 0 and m.winner is null then
    raise exception '% has no result to revert', m.key;
  end if;
  perform public.tournament_apply_score(p_match, p_score_a, p_score_b);
  -- Reverting or leaving a series undecided is not a "kind" of result, so it goes back to the default.
  update tournament_matches
     set result_kind = case when winner is null then 'played' else 'admin' end
   where id = p_match;
  perform public.tournament_settle_forfeits(m.tournament_id);
end;
$$;

grant execute on function public.set_tournament_match_score(uuid, int, int) to authenticated;

-- ===========================================================================
--  Deadlines and agreed times
-- ===========================================================================

-- Admin: move a round's window. Applies to every match in that stage and phase.
create or replace function public.set_round_window(
  p_tournament uuid, p_stage text, p_phase int, p_opens timestamptz, p_due timestamptz
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  changed int;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can set a deadline';
  end if;
  if p_opens is null or p_due is null or p_due <= p_opens then
    raise exception 'A round has to close after it opens';
  end if;

  update tournament_matches
     set opens_at = p_opens, due_at = p_due, updated_at = now()
   where tournament_id = p_tournament and stage = p_stage and phase = p_phase;
  get diagnostics changed = row_count;
  if changed = 0 then
    raise exception 'There are no % matches in round % of that event', p_stage, p_phase;
  end if;
  return changed;
end;
$$;

grant execute on function public.set_round_window(uuid, text, int, timestamptz, timestamptz) to authenticated;

-- A team captain (or an admin) records when the two teams have agreed to play. Shown on the bracket
-- so opponents and casters can see it; it moves nothing and enforces nothing. Captains can only pick
-- a time inside the round's window - an "agreed" time after the deadline would defeat the deadline -
-- while an admin can record anything, since they are the ones who extend a deadline.
create or replace function public.set_match_time(p_match uuid, p_at timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m tournament_matches%rowtype;
  t_status text;
begin
  select * into m from tournament_matches where id = p_match;
  if not found then
    raise exception 'There is no such tournament match';
  end if;

  if not (
    public.is_admin()
    or (m.entrant_a is not null and public.is_entrant_captain(m.entrant_a))
    or (m.entrant_b is not null and public.is_entrant_captain(m.entrant_b))
  ) then
    raise exception 'Only a captain of one of the two teams can set the time';
  end if;

  select t.status into t_status from tournaments t where t.id = m.tournament_id;
  if t_status <> 'live' then
    raise exception 'Match times can only be set while the event is running';
  end if;
  if m.status not in ('ready', 'in_progress') then
    raise exception '% is not waiting to be played', m.key;
  end if;

  if p_at is not null and not public.is_admin() then
    if m.opens_at is not null and p_at < m.opens_at then
      raise exception 'That is before this round opens';
    end if;
    if m.due_at is not null and p_at > m.due_at then
      raise exception 'That is after this round''s deadline - ask an administrator to extend it';
    end if;
  end if;

  update tournament_matches set agreed_at = p_at, agreed_by = auth.uid(), updated_at = now() where id = p_match;
end;
$$;

grant execute on function public.set_match_time(uuid, timestamptz) to authenticated;

-- The admins' "who is late" list: open matches past their due date, oldest first. Computed against the
-- database's clock, not the browser's, so a wrong laptop clock cannot make the list lie.
create or replace function public.overdue_tournament_matches(p_tournament uuid)
returns table (
  match_id uuid, match_key text, stage text, phase int, due_at timestamptz,
  status text, entrant_a uuid, entrant_b uuid, agreed_at timestamptz, overdue_by interval
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can see the overdue list';
  end if;
  return query
    select m.id, m.key, m.stage, m.phase, m.due_at, m.status, m.entrant_a, m.entrant_b, m.agreed_at,
           now() - m.due_at
      from tournament_matches m
     where m.tournament_id = p_tournament
       and m.status in ('ready', 'in_progress')
       and m.due_at is not null
       and m.due_at < now()
     order by m.due_at, m.key;
end;
$$;

grant execute on function public.overdue_tournament_matches(uuid) to authenticated;

-- ===========================================================================
--  Substitutions
-- ===========================================================================
-- Over a month, players drop out. Swaps are an administrator's call - captains ask in Discord, where
-- the rest of the event is run - so there is no request queue here, just the action. The incoming
-- player has to have signed in with Twitch on the site once, since a roster row is a real account.

create or replace function public.substitute_player(p_entrant uuid, p_out uuid, p_in_login text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
  e_status text;
  t_status text;
  in_id uuid;
  in_name text;
  in_login text := public.normalize_twitch_login(p_in_login);
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can substitute a player';
  end if;

  select e.tournament_id, e.status into tid, e_status from tournament_entrants e where e.id = p_entrant;
  if tid is null then
    raise exception 'There is no such team';
  end if;
  if e_status not in ('pending', 'approved') then
    raise exception 'That team is not in the event';
  end if;
  select t.status into t_status from tournaments t where t.id = tid;
  if t_status not in ('signup', 'live') then
    raise exception 'Substitutions are for events that are taking signups or running';
  end if;

  if not exists (select 1 from tournament_roster r where r.entrant_id = p_entrant and r.user_id = p_out) then
    raise exception 'That player is not on this team';
  end if;
  if exists (select 1 from tournament_roster r where r.entrant_id = p_entrant and r.user_id = p_out and r.is_captain) then
    raise exception 'The captain cannot be substituted out - hand the captaincy to someone else first';
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

  delete from tournament_roster where entrant_id = p_entrant and user_id = p_out;
  insert into tournament_roster (entrant_id, user_id, display_name) values (p_entrant, in_id, in_name);
end;
$$;

grant execute on function public.substitute_player(uuid, uuid, text) to authenticated;

-- Free agents can now be placed while the event is running too - a team that lost a player mid-event
-- can be topped up from the pool. Forming a brand-new team stays pre-start only, because the bracket
-- is built from the teams that exist when it starts. Reproduced in full; the change is the status test.
create or replace function public.assign_free_agent_to_team(p_entrant uuid, p_user uuid)
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
  fa_name text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can place a player';
  end if;

  select e.tournament_id, e.status into tid, e_status from tournament_entrants e where e.id = p_entrant;
  if tid is null then
    raise exception 'There is no such team';
  end if;
  if e_status not in ('pending', 'approved') then
    raise exception 'That team is not taking players';
  end if;

  select t.status, t.max_roster into t_status, cap from tournaments t where t.id = tid;
  if t_status not in ('draft', 'signup', 'live') then
    raise exception 'Players can only be placed while the event is being set up or running';
  end if;

  select fa.display_name into fa_name from tournament_free_agents fa
   where fa.tournament_id = tid and fa.user_id = p_user and fa.status = 'waiting';
  if fa_name is null then
    raise exception 'That player is not waiting for a team';
  end if;

  if (select count(*) from tournament_roster r where r.entrant_id = p_entrant) >= cap then
    raise exception 'That team is full (% players)', cap;
  end if;

  insert into tournament_roster (entrant_id, user_id, display_name) values (p_entrant, p_user, fa_name);
end;
$$;
