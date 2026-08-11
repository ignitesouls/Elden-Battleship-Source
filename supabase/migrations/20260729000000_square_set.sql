-- Which pool a room's squares come from.
--
-- The board used to be boss names and only boss names, drawn from a list compiled into the client.
-- A room can now be dealt from any squareset in the community's format - "Acquire 3 Legendary
-- Spirit Ashes" sits on a square as happily as "Kill Metyr" - and the host picks which in the lobby.
--
-- Free-form text rather than an enum or a check constraint, deliberately. The sets themselves live
-- in the client (src/lib/squareSets.ts) and are chosen by id; keeping the column unconstrained means
-- adding a set is a .json file and one line of TypeScript, with no migration and no window where a
-- deployed client offers a value the database rejects. Anything the client doesn't recognize falls
-- back to the default set, so a bad value costs a board nothing.
--
-- Null means the default ('bosses'), which is what every room created before this migration was.
alter table rooms add column if not exists square_set text;

comment on column rooms.square_set is
  'Id of the square set this room deals its board from (see src/lib/squareSets.ts). Null = the default set.';
