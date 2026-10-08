-- When an archived match's board was dealt.
--
-- A square can now join the boss set after boards are already being dealt from it - Crucible Knight
-- Devonia is the first. The shuffle consumes one draw per square, so a longer list deals a different
-- board from the same room, and every match ever played would rebuild wrong. So a late square carries
-- the instant it starts being dealt (`dealtFrom` in battleshipChallenges.json), and every rebuild
-- leaves it out of any board dealt before then - see squareSetFormat.dealtPool.
--
-- A live room already knows when its board was dealt: rooms.seed_set_at, stamped by the server. An
-- archived match does not, and the room is pruned about an hour after it goes quiet. This copies the
-- stamp onto the archive at the moment the match is written, alongside the seed it describes.
--
-- -- Why a trigger and not a change to archive_match ------------------------------------------------
--
-- archive_match is two hundred lines that have been re-issued six times, and a seventh copy to add one
-- column is six chances to drop something that is not this. The stamp is also a fact about the room,
-- not about anything archive_match computes - the same reason rooms.seed_set_at is a trigger. It runs
-- inside archive_match's own insert, so it reads the room in the same transaction as board_seed was.
--
-- -- DELIBERATELY NOT BACKFILLED -------------------------------------------------------------------
--
-- Null reads as "dealt before every late square", which is exactly true of every match archived
-- before this column existed: no late square has ever been dealt. Same rule as seed_set_at.

alter table public.match_events add column if not exists board_dealt_at timestamptz;

create or replace function public.stamp_board_dealt_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.board_dealt_at is null and new.room_id is not null then
    -- Only when the room is still on the seed this row was archived with. If the room has rerolled
    -- since, its stamp describes a different board, and null ("before") is the honest answer.
    select r.seed_set_at into new.board_dealt_at
    from rooms r
    where r.id = new.room_id
      and r.seed is not distinct from new.board_seed;
  end if;
  return new;
end;
$$;

drop trigger if exists match_events_stamp_board_dealt_at on public.match_events;
create trigger match_events_stamp_board_dealt_at
  before insert on public.match_events
  for each row
  execute function public.stamp_board_dealt_at();

-- The view gains the column at the END, which is the only change `create or replace view` allows.
-- Same first-non-null rule as its companions, for the same reason - see 20260830000000.
create or replace view public.match_board_sources
with (security_invoker = true) as
select
  e.match_key,
  (array_agg(e.room_id)    filter (where e.room_id    is not null))[1] as room_id,
  (array_agg(e.board_seed) filter (where e.board_seed is not null))[1] as board_seed,
  (array_agg(e.board_perm) filter (where e.board_perm is not null))[1] as board_perm,
  (array_agg(e.square_set) filter (where e.square_set is not null))[1] as square_set,
  max(e.board_size) as board_size,
  (array_agg(e.board_dealt_at) filter (where e.board_dealt_at is not null))[1] as board_dealt_at
from public.match_events e
group by e.match_key;

grant select on public.match_board_sources to anon, authenticated;
