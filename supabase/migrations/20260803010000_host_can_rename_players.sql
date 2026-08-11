-- The host may edit any player row in their own room.
--
-- Applied by hand on 3 Aug 2026 and recorded here so the migration history matches the database.
--
-- What it is for: renaming a crewmate whose nickname is unreadable on stream, and moving somebody
-- who picked the wrong fleet. Both were host powers in the desktop app and neither was expressible
-- under the previous policy, which only let a player update their own row.
--
-- What it grants, stated plainly: the host can update ANY column of any player row in their room,
-- including is_host. That is broader than the two operations the UI offers. It is acceptable here
-- because a room is a group of people who chose to play together and the host already ends matches
-- and kicks players - this is a co-operative control, not an authorisation boundary. It is scoped
-- to the host's own room, so it can never reach a player in a different game.
drop policy if exists "players update by host" on public.players;

create policy "players update by host" on public.players for update using (
  exists (
    select 1 from public.players host
    where host.room_id = players.room_id
      and host.user_id = auth.uid()
      and host.is_host = true
  )
);
