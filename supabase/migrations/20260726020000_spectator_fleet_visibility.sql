-- Lets a spectator (a player row in this room with team is null) read every fleet in that room,
-- so the spectator view can draw each team's ship positions.
--
-- ⚠ TRADE-OFF, READ THIS: ship positions are the one genuinely secret thing in this game, and
-- this policy hands them to anyone who joins a room and picks "Spectator". Nothing stops a
-- competing player from opening a second browser profile, joining the same room as a spectator,
-- and reading their opponent's board. That is inherent to "spectators can see ships" in a game
-- anyone can join by code - it cannot be closed while the feature exists as specified.
--
-- It is scoped as tightly as it can be: only rooms you have actually joined, and only while you
-- hold a spectator row in them. If you'd rather trade live spectating for airtight secrecy,
-- add `and exists (select 1 from rooms r where r.id = fleets.room_id and r.status = 'finished')`
-- to the policy below - spectators then see ships only in the post-match recap.
create policy "fleets select by spectator" on fleets for select using (
  exists (
    select 1 from players p
    where p.room_id = fleets.room_id
      and p.user_id = auth.uid()
      and p.team is null
  )
);
