-- Fixes "match doesn't reset": bulk-deleting a room's attacks (resetRoomToLobby) wasn't
-- reaching clients' realtime subscriptions, because `attacks.room_id` isn't part of its
-- primary key, and Postgres only replicates PK columns for DELETEs by default - not enough
-- data for the client's room_id filter to match. FULL identity includes every column.
alter table attacks replica identity full;
