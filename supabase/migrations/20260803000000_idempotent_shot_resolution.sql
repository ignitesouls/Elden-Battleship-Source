-- One square, one wound: make resolve_attack() idempotent per (fleet, square).
--
-- The bug: resolve_attack() decremented a ship's hit counter for EVERY attack row aimed at a
-- square, without asking whether that square had already been settled. A ship therefore sank after
-- N decrements rather than after N distinct squares were found, so a five-cell hull could go down
-- on four hits plus one repeat - which is exactly what a spectator reported (four burst markers on
-- a five-cell ship that the roster called sunk), and what "he clicked the same square twice and got
-- two hits" is the other half of.
--
-- Two ways a square gets a second attack row, and only one of them is a mistake:
--
--   * Two shots from the SAME fleet. A race - the client blocks a square it has already fired at,
--     but two crewmates clicking together (or one double-click landing before realtime echoes the
--     first row back) both pass that check. The client-side guard is tightened alongside this.
--   * Shots from DIFFERENT fleets. Not a mistake at all: a shot hits every other fleet at that same
--     square, so in a 3+ fleet match one defender legitimately collects a row per attacker for the
--     same square. Every one of those was landing a separate wound on the same piece of hull.
--
-- That second case is why this is fixed here rather than with a unique index on the table: the rows
-- are real and both attackers are owed a verdict. What must not repeat is the DAMAGE. So a shot at
-- a square this fleet has already had settled copies the earlier verdict verbatim and touches no
-- counters - the attacker still learns what is there, and the hull is only ever wounded once per
-- square.
--
-- Everything else about the function is unchanged from 20260726040000_qol_batch.sql; it is restated
-- in full because create-or-replace can't patch a function body.
create or replace function public.resolve_attack(p_attack_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  atk           attacks%rowtype;
  prior         attacks%rowtype;
  flt           fleets%rowtype;
  defs          jsonb;
  ship_idx      int;
  hits          jsonb;
  sunk          jsonb;
  new_hits      int;
  placement     jsonb;
  v_result      text;
  v_name        text;
  v_size        int;
  v_row         int;
  v_col         int;
  v_horiz       boolean;
  survivors     int;
  winner        int;
begin
  -- Locking the attack row first makes this idempotent for one row: a second concurrent caller for
  -- the same attack blocks here, then re-reads the committed row and returns the already-decided
  -- result instead of applying a second decrement.
  select * into atk from attacks where id = p_attack_id for update;
  if not found then return null; end if;
  if atk.result <> 'pending' then return atk.result; end if;
  if atk.cell_index < 0 then return null; end if;  -- bookkeeping marker, never a real shot

  select * into flt from fleets
    where room_id = atk.room_id and team = atk.defender_team
    for update;
  if not found then return null; end if;

  -- Has this fleet already had this square settled? Checked while holding the fleet lock, which is
  -- what makes it airtight rather than merely likely: every resolution against this fleet is
  -- serialized on that row, so two shots racing at one square can't both look and both find nothing.
  --
  -- Ordered oldest-first so the verdict copied is the one the square actually produced, and the
  -- answer doesn't change depending on which duplicate is resolved next.
  select * into prior from attacks
    where room_id = atk.room_id
      and defender_team = atk.defender_team
      and cell_index = atk.cell_index
      and id <> atk.id
      and result <> 'pending'
    order by resolved_at nulls last, created_at
    limit 1;

  if found then
    update attacks
       set result          = prior.result,
           resolved_at     = now(),
           sunk_ship_name  = prior.sunk_ship_name,
           sunk_ship_size  = prior.sunk_ship_size,
           sunk_start_row  = prior.sunk_start_row,
           sunk_start_col  = prior.sunk_start_col,
           sunk_horizontal = prior.sunk_horizontal
     where id = p_attack_id;
    -- No fleet write, and deliberately no elimination check: nothing about the fleet changed, so
    -- there is nothing new to conclude about whether it is still afloat.
    return prior.result;
  end if;

  select r.ship_defs into defs from rooms r where r.id = atk.room_id;

  if coalesce((flt.ship_grid ->> atk.cell_index)::boolean, false) is not true then
    v_result := 'miss';
  else
    ship_idx := (flt.ship_index_grid ->> atk.cell_index)::int;
    hits     := flt.ship_hits_remaining;
    sunk     := flt.ship_sunk;
    new_hits := greatest(0, coalesce((hits ->> ship_idx)::int, 0) - 1);
    hits     := jsonb_set(hits, array[ship_idx::text], to_jsonb(new_hits));

    if new_hits <= 0 then
      v_result  := 'sunk';
      sunk      := jsonb_set(sunk, array[ship_idx::text], 'true'::jsonb);
      placement := flt.placements -> ship_idx;
      v_name    := defs -> ship_idx ->> 'name';
      v_size    := (defs -> ship_idx ->> 'size')::int;
      if placement is not null then
        v_row   := (placement ->> 'startRow')::int;
        v_col   := (placement ->> 'startCol')::int;
        v_horiz := (placement ->> 'isHorizontal')::boolean;
      end if;
    else
      v_result := 'hit';
    end if;

    update fleets
       set ship_hits_remaining = hits, ship_sunk = sunk
     where room_id = atk.room_id and team = atk.defender_team;
  end if;

  update attacks
     set result          = v_result,
         resolved_at     = now(),
         sunk_ship_name  = v_name,
         sunk_ship_size  = v_size,
         sunk_start_row  = v_row,
         sunk_start_col  = v_col,
         sunk_horizontal = v_horiz
   where id = p_attack_id;

  -- Whole fleet gone? Publish the elimination and, if only one side is left standing, end the
  -- match. Done here rather than client-side because the team that just lost is precisely the
  -- one least likely to still be connected to announce it.
  if v_result = 'sunk'
     and jsonb_array_length(sunk) > 0
     and not (sunk @> 'false'::jsonb) then
    insert into team_ready (room_id, team, eliminated)
    values (atk.room_id, atk.defender_team, true)
    on conflict (room_id, team) do update set eliminated = true;

    select count(*), min(x.t) into survivors, winner
    from (select distinct p.team as t from players p
           where p.room_id = atk.room_id and p.team is not null) x
    where not exists (
      select 1 from team_ready tr
       where tr.room_id = atk.room_id and tr.team = x.t and tr.eliminated
    );

    if survivors <= 1 then
      update rooms
         set status = 'finished',
             winner_team = case when survivors = 1 then winner else null end
       where id = atk.room_id and status = 'battle';
    end if;
  end if;

  return v_result;
end;
$$;

grant execute on function public.resolve_attack(uuid) to anon, authenticated;

-- Speeds up the lookup this adds, which now runs on every single shot in the game. Without it the
-- prior-verdict query is a scan of the room's whole attack log per resolution.
create index if not exists attacks_room_defender_cell_idx
  on attacks (room_id, defender_team, cell_index);
