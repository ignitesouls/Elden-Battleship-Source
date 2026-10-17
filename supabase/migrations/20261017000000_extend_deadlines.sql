-- Extensions: more time for one match, or for every open match in its round, at any point - not only
-- once a match is already overdue.
--
-- set_round_window moves a whole round to one window and was the only way to give time, from the overdue
-- list. That made two things impossible: helping the one pair whose player is ill without relaxing the
-- deadline for everyone else in the round, and granting time a day BEFORE the deadline, when the request
-- usually arrives. This adds days to each match's own deadline instead of setting one, so a match that
-- already had an extension keeps its lead when the whole round is later given more, and nothing already
-- played is touched.
--
-- Deadlines stay advisory (see 20260921030000_tournament_schedule.sql): this only moves the date the
-- overdue list and the captains' agreed-time check read. Rounds after this one are not moved.

create or replace function public.extend_tournament_deadline(p_match uuid, p_days int, p_whole_round boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  m tournament_matches%rowtype;
  t_status text;
  changed int;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can extend a deadline';
  end if;
  if p_days is null or p_days < 1 or p_days > 60 then
    raise exception 'An extension is between 1 and 60 days';
  end if;

  select * into m from tournament_matches where id = p_match;
  if not found then
    raise exception 'There is no such tournament match';
  end if;
  select t.status into t_status from tournaments t where t.id = m.tournament_id;
  if t_status <> 'live' then
    raise exception 'Deadlines can only be extended while the event is running';
  end if;

  if p_whole_round then
    update tournament_matches
       set due_at = due_at + make_interval(days => p_days), updated_at = now()
     where tournament_id = m.tournament_id and stage = m.stage and phase = m.phase
       and status in ('pending', 'ready', 'in_progress') and due_at is not null;
  else
    if m.status not in ('pending', 'ready', 'in_progress') then
      raise exception '% has already been decided', m.key;
    end if;
    if m.due_at is null then
      raise exception '% has no deadline to extend', m.key;
    end if;
    update tournament_matches
       set due_at = due_at + make_interval(days => p_days), updated_at = now()
     where id = p_match;
  end if;

  get diagnostics changed = row_count;
  if changed = 0 then
    raise exception 'Every match in that round has already been decided';
  end if;
  return changed;
end;
$$;

grant execute on function public.extend_tournament_deadline(uuid, int, boolean) to authenticated;
