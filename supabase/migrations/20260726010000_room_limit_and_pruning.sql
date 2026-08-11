-- Caps how many rooms can exist at once, and reaps abandoned ones.
--
-- Two mechanisms, deliberately layered:
--   1. prune_stale_rooms() deletes rooms with no activity for an hour. Deleting a room cascades
--      to its players/fleets/team_ready/attacks (all are `on delete cascade`), so this is a
--      complete cleanup, not just a tombstone.
--   2. A BEFORE INSERT trigger on `rooms` prunes first, then rejects the insert if the cap is
--      still hit. Pruning on the create path is what makes the cap self-healing: the only moment
--      the limit can actually block anyone is also the moment stale rooms get cleared, so a
--      backlog of dead rooms can never permanently lock out new games even with no cron running.
--
-- "Activity" is computed on the fly from rows that already exist (newest attack, newest player
-- join, else the room's own created_at) rather than a last_activity_at column kept fresh by
-- triggers. That was the deliberate choice: `rooms` is in the realtime publication, so bumping a
-- column on it per attack would broadcast a room UPDATE to every connected client on every single
-- shot - pure re-render noise - and would serialize concurrent shots on one row.

-- --- the reaper ----------------------------------------------------------
create or replace function public.prune_stale_rooms()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  with activity as (
    select
      r.id,
      r.status,
      greatest(
        r.created_at,
        coalesce((select max(a.created_at) from attacks a where a.room_id = r.id), r.created_at),
        coalesce((select max(p.joined_at)  from players p where p.room_id = r.id), r.created_at)
      ) as last_active
    from rooms r
  ),
  dead as (
    delete from rooms r
    using activity act
    where act.id = r.id
      and act.last_active < case
            -- A finished match is already over, so it doesn't need the full idle window. Without
            -- this, a handful of quick back-to-back matches could hold seats against the cap for
            -- an hour each and starve new rooms. Drop this branch if you'd rather every room get
            -- the same hour regardless of state.
            when act.status = 'finished' then now() - interval '10 minutes'
            else now() - interval '1 hour'
          end
    returning 1
  )
  select count(*) into removed from dead;

  return removed;
end;
$$;

-- Deliberately not callable by players: it's reached through the insert trigger (which runs as
-- the definer) and by the scheduled job below.
revoke all on function public.prune_stale_rooms() from public;

-- --- the cap -------------------------------------------------------------
create or replace function public.enforce_room_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  max_rooms constant integer := 15;
  room_count integer;
begin
  perform public.prune_stale_rooms();

  select count(*) into room_count from rooms;

  if room_count >= max_rooms then
    -- check_violation (23514), NOT unique_violation (23505): createRoom() retries on 23505 to
    -- dodge room-code collisions, and a capacity error must break out of that loop immediately
    -- instead of silently burning all five attempts and surfacing as a code-allocation failure.
    raise exception
      'All % game rooms are currently in use. Rooms are cleared automatically after an hour of inactivity - try again in a bit, or join an existing room with its code.',
      max_rooms
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists rooms_enforce_limit on rooms;
create trigger rooms_enforce_limit
  before insert on rooms
  for each row
  execute function public.enforce_room_limit();
