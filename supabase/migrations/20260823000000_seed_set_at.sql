-- When a room's board was last randomized.
--
-- Igon (src/lib/deepWater.ts) is revealed on a date, and the thing that has to be dated is the
-- moment a lobby ROLLED ITS BOARD - not the moment the room was made. Rooms outlive matches: a room
-- created last week and re-randomized tonight is playing tonight's board, and it should get tonight's
-- easter egg. `created_at` cannot tell those apart.
--
-- There are three ways a seed gets written - a new room (rooms.createRoom), the lobby's randomize
-- button (rooms.rerollSeed), and the reroll baked into the end of a match (rooms.resetRoomToLobby) -
-- and there will be more. So this is a trigger rather than three call sites remembering to stamp it:
-- the column is a fact about the seed, and it is maintained wherever the seed is.
--
-- It is also why the stamp is `now()` and not a timestamp sent by a client. Whether an egg is live is
-- exactly the sort of thing somebody would enjoy moving their system clock for, and a client-supplied
-- time would make the reveal a suggestion.

alter table rooms add column if not exists seed_set_at timestamptz;

-- DELIBERATELY NOT BACKFILLED.
--
-- The obvious move is `update rooms set seed_set_at = created_at`, and it is the one thing in this
-- migration that could have touched a match in progress: `rooms` is in the realtime publication and
-- every client watches its own row, so rewriting every room would have pushed an UPDATE into every
-- live game at once. Harmless in the end - the handler only branches on a status flip - but it is
-- work done to sleeping tables for no reason.
--
-- And there is no reason, because null already means what the backfill would have written. See
-- squareSetFormat.igonUnveiled: a missing stamp reads as "too early", which is exactly right for a
-- board dealt before the feature existed. Rooms fill the column in themselves, the next time they
-- roll a seed, which is the only moment it describes.

create or replace function stamp_seed_set_at()
returns trigger
language plpgsql
as $$
begin
  -- `is distinct from` rather than `<>` so a seed going from null to a value counts, and so the
  -- hundred other updates a room takes - status flips, team names, board_perm - leave it alone.
  if tg_op = 'INSERT' or new.seed is distinct from old.seed then
    new.seed_set_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists rooms_stamp_seed_set_at on rooms;
create trigger rooms_stamp_seed_set_at
  before insert or update on rooms
  for each row
  execute function stamp_seed_set_at();
