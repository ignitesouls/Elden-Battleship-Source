-- Fixes match reset only ever partially working: the host's "End match"/"Play again" loop
-- resets every team's fleet, but RLS only allowed a team to write its OWN fleet row, so every
-- OTHER team's old ship placements silently survived. team_ready had no delete policy at all,
-- so stale ready/eliminated flags always survived too. Run in the SQL Editor.

create policy "fleets reset by host" on fleets for update using (
  exists (
    select 1 from players host
    where host.room_id = fleets.room_id
      and host.user_id = auth.uid()
      and host.is_host = true
  )
);

create policy "team_ready delete by host" on team_ready for delete using (
  exists (
    select 1 from players host
    where host.room_id = team_ready.room_id
      and host.user_id = auth.uid()
      and host.is_host = true
  )
);
