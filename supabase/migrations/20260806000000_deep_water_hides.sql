-- The deep, rolled once, the moment the fleets are set.
--
-- Everything hiding in the water used to be worked out client-side by walking the public attack
-- log: a creature sat on the first square nobody had fired at, and a shot that came back a miss
-- proved that square was open water. It did not prove it, and this migration is why.
--
-- A shot writes ONE ROW PER OPPONENT. The shooter's own fleet is never a defender of their own
-- shot, so a "miss" only ever proved the OTHER fleets were empty there - the shooter's own hull
-- could be sitting on the square, and regularly was. That is how a tentacle came to be found on a
-- square the finding crew had a ship on, which is the one thing the whole mechanic promised could
-- not happen.
--
-- No client can fix it, because no client is allowed the information: `fleets` RLS means a player
-- reads their own layout and nobody else's. Postgres can see all of them, so Postgres picks the
-- squares - once, after every fleet is confirmed and before a single shot is fired, from the cells
-- NO fleet occupies. Fixed for the match, and true by construction rather than by inference.

-- --- where things are hiding (PRIVATE until fired upon) --------------------
create table if not exists deep_hides (
  room_id uuid not null references rooms(id) on delete cascade,
  cell_index int not null,
  creature text not null check (creature in ('whale', 'tentacle', 'dutchman', 'bottle', 'alexander')),
  -- One in five: this square is the decoy rather than the thing. Laboon on a 'whale' square,
  -- Patches on a 'tentacle' square, and nothing anywhere else.
  --
  -- Rolled here rather than in the client because it has to be as secret as the position is: the
  -- old version keyed it off the room id, which meant anybody who could compute a square could
  -- compute whether it was worth firing at. With positions fixed, the decoy costs a crew the real
  -- thing - the whale is not somewhere else, he simply is not found this match.
  decoy boolean not null default false,
  primary key (room_id, cell_index)
);

alter table deep_hides enable row level security;

-- Revealed one square at a time, and only by firing at it.
--
-- This is the whole secrecy model, and it is now a property of the data rather than a policy the
-- client is trusted to follow: an unfound creature's row is invisible to EVERY client, so there is
-- nothing to read out of devtools and nothing to compute from the seed. A row that has been fired
-- at is telling you something you already know - you shot there and it was water.
--
-- Deliberately not scoped to the firing team. A caster's overlay holds no player row for the room
-- and must still see finds as they land; who is SHOWN what, among people who can read the row, is
-- still decided by deepMarks() in src/lib/deepWater.ts.
drop policy if exists "deep_hides select once fired at" on deep_hides;
create policy "deep_hides select once fired at" on deep_hides for select using (
  exists (
    select 1 from attacks a
    where a.room_id = deep_hides.room_id
      and a.cell_index = deep_hides.cell_index
      and a.result <> 'pending'
  )
);

-- Cleared with the attack log when a room goes back to the lobby (resetRoomToLobby). Permissive to
-- match "attacks delete", and for the same reason: an RLS-blocked delete removes zero rows and
-- reports no error, so the next match would quietly reuse the last one's squares.
drop policy if exists "deep_hides delete" on deep_hides;
create policy "deep_hides delete" on deep_hides for delete using (true);

-- No insert or update policy exists on purpose. The roll below is SECURITY DEFINER and bypasses
-- RLS; nothing else may write here, or a client could plant a creature on a square it wanted
-- proven empty.

-- --- the roll -------------------------------------------------------------
-- Called from startBattle() (src/lib/rooms.ts), after every fleet has confirmed and before the
-- status flips to 'battle'. Returns how many squares it hid something on, so the client can tell
-- "rolled nothing, board too small" from "this project has not run the migration".
create or replace function roll_deep_water(p_room_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_size      int;
  v_cells     int;
  v_free      int[];
  v_tentacles int;
  v_extras    boolean;
  v_placed    int;
begin
  select board_size into v_size from rooms where id = p_room_id;
  if v_size is null then
    return 0;
  end if;
  v_cells := v_size * v_size;

  -- Never mid-match. A re-roll after the shooting starts would move a creature off a square
  -- somebody has already been told is empty, and could move one onto a square already hit.
  if exists (select 1 from attacks where room_id = p_room_id and cell_index >= 0) then
    return (select count(*)::int from deep_hides where room_id = p_room_id);
  end if;

  -- Never while a hull can still move. Every team that actually has players in the room must have
  -- confirmed; stale fleet rows for teams nobody is on are ignored, since nothing will ever be
  -- placed on them.
  if exists (
    select 1 from fleets f
    where f.room_id = p_room_id
      and not f.placement_confirmed
      and exists (
        select 1 from players p
        where p.room_id = p_room_id and p.team = f.team
      )
  ) then
    return 0;
  end if;

  delete from deep_hides where room_id = p_room_id;

  -- Every cell no fleet occupies, shuffled. `ship_grid` is a flat jsonb bool array indexed by cell
  -- index (see battleshipLogic.emptyGrid), so this is one containment test per fleet per cell.
  select coalesce(array_agg(c order by random()), '{}')
    into v_free
  from generate_series(0, v_cells - 1) as c
  where not exists (
    select 1 from fleets f
    where f.room_id = p_room_id
      and coalesce(f.ship_grid -> c, 'false'::jsonb) = 'true'::jsonb
  );

  -- Mirrors tentacleCount()/hidesExtras() in src/lib/deepWater.ts, which still computes how many
  -- tentacles a board HAS - the client cannot count the rows, because the ones nobody has found
  -- are invisible to it. The two must agree or "Cthulhu wakes" fires at the wrong count.
  v_extras := v_cells >= 64;
  v_tentacles := case when v_extras then least(6, greatest(3, round(v_cells * 0.04)::int)) else 0 end;

  -- Ordered by `ord`, so on a board with barely any open water the whale is hidden first and
  -- Alexander is the one who misses out.
  with wanted(ord, creature, n) as (
    values (1, 'whale'::text, 1),
           (2, 'tentacle', v_tentacles),
           (3, 'dutchman', case when v_extras then 3 else 0 end),
           (4, 'bottle', case when v_extras then 4 else 0 end),
           (5, 'alexander', case when v_extras then 1 else 0 end)
  ),
  slots as (
    select w.creature, row_number() over (order by w.ord, g.i) as slot
    from wanted w
    cross join lateral generate_series(1, w.n) as g(i)
  )
  insert into deep_hides (room_id, cell_index, creature, decoy)
  select p_room_id,
         v_free[slot::int],
         creature,
         creature in ('whale', 'tentacle') and random() < 0.2
  from slots
  where slot <= coalesce(array_length(v_free, 1), 0);

  get diagnostics v_placed = row_count;
  return v_placed;
end;
$$;

revoke all on function roll_deep_water(uuid) from public;
grant execute on function roll_deep_water(uuid) to anon, authenticated;
