-- Records which room a shot belonged to.
--
-- The challenge grid is generated deterministically from the room id (challengesForRoom), so
-- storing that one uuid lets the almanac reconstruct the FULL boss list for a board - not just
-- the bosses somebody happened to shoot at. That's what makes "appeared but was never fired at"
-- answerable, which is otherwise impossible: match_events only ever contains shots that happened.
--
-- Storing the id beats storing the resolved name list: it's 16 bytes instead of a hundred
-- strings per match, and it stays correct if the challenge pool is ever re-tuned.
alter table match_events add column if not exists room_id uuid;
alter table match_fleets add column if not exists room_id uuid;
