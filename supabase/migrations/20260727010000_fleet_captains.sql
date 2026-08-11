-- Fleet captains: the first player to pick a team runs it.
--
-- Derived from a timestamp rather than stored as an `is_captain` flag, deliberately. A flag needs
-- succession logic - when the captain leaves, somebody has to notice and promote the next player,
-- which is a whole RPC and a race to get wrong (ensure_room_host() exists precisely because the
-- host flag has this problem). Ordering by "who picked this fleet first" needs none of that: the
-- captain leaving simply makes the next-earliest member the captain, instantly and on every
-- client at once, with nothing to write.
--
-- players.joined_at can't be reused for this. It records joining the ROOM, so someone who sat in
-- the lobby a while and then picked Red would outrank the person who picked Red immediately.
alter table players add column if not exists team_joined_at timestamptz;

-- Existing rows: fall back to room join time. Imperfect ordering for teams formed before this
-- migration, but it always yields exactly one captain, which is what matters.
update players set team_joined_at = joined_at
 where team is not null and team_joined_at is null;

create index if not exists players_team_order_idx on players (room_id, team, team_joined_at);

/**
 * The captain of one fleet: earliest to pick it, id as a deterministic tie-break.
 *
 * The tie-break isn't paranoia - two players picking the same fleet in the same millisecond would
 * otherwise both be captain, and both could place ships over each other.
 */
create or replace function public.team_captain(p_room uuid, p_team int)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
    from players p
   where p.room_id = p_room
     and p.team = p_team
   order by p.team_joined_at nulls last, p.id
   limit 1;
$$;

grant execute on function public.team_captain(uuid, int) to anon, authenticated;

-- -- Only the captain places ships ------------------------------------------
-- A trigger rather than an RLS policy, for the same reason the team lock is one: this restricts
-- particular COLUMNS. Teammates still need to write the rest of the fleet row - resetOwnTeamState()
-- has every client clear its own team's board when a match resets, and requiring the captain to be
-- present for that would strand the board if they'd closed the tab.
--
-- Scoped to the 'placement' phase only, so that reset path (which runs in 'lobby') is untouched.
create or replace function public.guard_fleet_placement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.placements is distinct from old.placements
      or new.placement_confirmed is distinct from old.placement_confirmed)
     and exists (select 1 from rooms r where r.id = new.room_id and r.status = 'placement')
     and not public.is_admin()
     and not exists (
       select 1 from players p
        where p.id = public.team_captain(new.room_id, new.team)
          and p.user_id = auth.uid()
     )
  then
    raise exception 'Only the fleet captain places this team''s ships';
  end if;

  return new;
end;
$$;

drop trigger if exists fleets_guard_placement on fleets;
create trigger fleets_guard_placement
  before update on fleets
  for each row execute function public.guard_fleet_placement();
