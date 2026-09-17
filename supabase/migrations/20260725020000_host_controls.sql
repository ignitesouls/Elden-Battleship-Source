-- Lets the room's host kick other players (delete their row). The existing
-- "players delete own" policy only allows self-removal; this adds host removal
-- as an additional (OR'd) delete policy. Run in the SQL Editor of your existing project.

drop policy if exists "players delete by host" on players;
create policy "players delete by host" on players for delete using (
  exists (
    select 1 from players host
    where host.room_id = players.room_id
      and host.user_id = auth.uid()
      and host.is_host = true
  )
);
