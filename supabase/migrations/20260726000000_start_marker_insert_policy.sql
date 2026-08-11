-- The match-start marker (rooms.ts startBattle()) inserts a sentinel attacks row with
-- attacker_team = -1 / defender_team = -1, which no real player ever has as their team, so the
-- existing "attacks insert by attacker" policy's `p.team = attacks.attacker_team` check always
-- evaluated false for it. RLS silently rejected the insert (startBattle() didn't check the
-- error), which was invisible as long as matchStartedAt() could fall back to the earliest real
-- shot - but the STARTING/PREPARATION countdown needs the marker to exist before any shot is
-- fired, so the gap is now visible as a clock that never starts. Any room member may insert it;
-- it carries no ship data and startBattle() is only ever called by the host client anyway.
create policy "attacks insert start marker" on attacks for insert with check (
  cell_index = -1
  and exists (
    select 1 from players p
    where p.room_id = attacks.room_id
      and p.user_id = auth.uid()
  )
);
