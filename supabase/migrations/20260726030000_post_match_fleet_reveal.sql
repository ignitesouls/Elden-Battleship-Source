-- Reveals every fleet in a room once that match is over, to anyone who was in the room.
--
-- Needed by the post-match report, which shows both fleets side by side - a player can normally
-- only ever read their own team's row, so without this the recap could only ever draw half the
-- picture.
--
-- Unlike the spectator policy this one is not exploitable: it only opens up when
-- rooms.status = 'finished', by which point the shooting has stopped and the positions have no
-- competitive value left. It also can't be farmed for an advantage in a REMATCH, because
-- resetRoomToLobby() flips status back to 'lobby' and wipes placements before the next round.
create policy "fleets select after match" on fleets for select using (
  exists (
    select 1 from rooms r
    where r.id = fleets.room_id
      and r.status = 'finished'
  )
  and exists (
    select 1 from players p
    where p.room_id = fleets.room_id
      and p.user_id = auth.uid()
  )
);
