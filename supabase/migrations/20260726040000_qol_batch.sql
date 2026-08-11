-- Quality-of-life batch:
--   1. Per-room countdown lengths (STARTING / PREPARATION) instead of client constants.
--   2. resolve_attack() - authoritative, atomic, server-side attack resolution.
--   3. ensure_room_host() - promotes a new host when the room has none.
--   4. match_reports - post-match recaps that outlive the room pruner.

-- --- 1. per-room countdown lengths ---------------------------------------
alter table rooms add column if not exists starting_seconds int not null default 10;
alter table rooms add column if not exists prep_seconds int not null default 240;

-- --- 2. authoritative attack resolution ----------------------------------
-- Previously every attack was resolved by the DEFENDING team's own browser, which meant a team
-- that closed its tab left its incoming shots stuck on 'pending' forever and silently stalled
-- the match. It also forced a compare-and-swap retry loop in the client to stop concurrent hits
-- clobbering each other's hit-count decrement.
--
-- Doing it here fixes both: `select ... for update` on the fleet row serializes concurrent
-- resolutions properly (no retry loop, no lost updates), and because this is SECURITY DEFINER
-- any client may drive it - the defender no longer has to be online. Ship positions still never
-- reach a client: the function reads the fleet server-side and returns only hit/miss/sunk.
--
-- Lock order is always attacks -> fleets, so concurrent callers can't deadlock.
create or replace function public.resolve_attack(p_attack_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  atk           attacks%rowtype;
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
  -- Locking the attack row first makes this idempotent: a second concurrent caller for the same
  -- attack blocks here, then re-reads the committed row and returns the already-decided result
  -- instead of applying a second decrement.
  select * into atk from attacks where id = p_attack_id for update;
  if not found then return null; end if;
  if atk.result <> 'pending' then return atk.result; end if;
  if atk.cell_index < 0 then return null; end if;  -- bookkeeping marker, never a real shot

  select * into flt from fleets
    where room_id = atk.room_id and team = atk.defender_team
    for update;
  if not found then return null; end if;

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
  -- `sunk @> 'false'` is jsonb containment: true while any ship is still afloat. The length
  -- guard matters because an empty array contains no `false` either, which would otherwise
  -- read as "whole fleet destroyed" for a fleet that has no ships at all.
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

-- --- 3. host migration ---------------------------------------------------
-- is_host was only ever written once, at room creation, and never reassigned - so a host who
-- closed their tab left the room permanently unmanageable (nobody could start placement, kick,
-- end the match, or play again) and it sat there burning one of the 15 room slots until it was
-- pruned. This promotes the longest-tenured remaining player whenever a room has no host at all.
-- Deterministic ordering makes it safely idempotent: two clients racing pick the same winner.
create or replace function public.ensure_room_host(p_room_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  perform 1 from players where room_id = p_room_id and is_host limit 1;
  if found then return null; end if;

  select id into v_id from players
   where room_id = p_room_id
   order by joined_at asc, id asc
   limit 1;
  if v_id is null then return null; end if;

  update players set is_host = true where id = v_id;
  return v_id;
end;
$$;

grant execute on function public.ensure_room_host(uuid) to anon, authenticated;

-- Lets a room member take over hosting when the current host has gone dark but their player row
-- still exists (a closed tab never deletes it). Presence can't be proven in SQL, so the UI only
-- offers this once realtime presence shows the host offline - it is a co-operative control for a
-- friends' game, not an authorisation boundary.
create or replace function public.claim_room_host(p_player_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_room uuid;
begin
  select room_id into v_room from players
   where id = p_player_id and user_id = auth.uid();
  if v_room is null then return false; end if;

  update players set is_host = false where room_id = v_room and is_host;
  update players set is_host = true  where id = p_player_id;
  return true;
end;
$$;

grant execute on function public.claim_room_host(uuid) to anon, authenticated;

-- --- 4. persisted match reports ------------------------------------------
-- Rooms (and their attacks) are deleted an hour after they go quiet, taking every recap with
-- them. These rows deliberately carry no foreign key to rooms so they survive that cleanup.
-- match_key is the room code plus the match's start-marker timestamp, which every client derives
-- identically - so `on conflict do nothing` collapses the simultaneous writes from a full lobby
-- into a single saved report.
create table if not exists match_reports (
  id uuid primary key default gen_random_uuid(),
  match_key text unique not null,
  room_code text not null,
  winner_team int,
  duration text,
  total_shots int not null default 0,
  summary jsonb not null default '{}',
  report_text text not null default '',
  finished_at timestamptz not null default now()
);

alter table match_reports enable row level security;

create policy "match_reports select" on match_reports for select using (true);
create policy "match_reports insert" on match_reports for insert with check (true);

create index if not exists match_reports_finished_at_idx on match_reports (finished_at desc);

-- --- 5. keep the reaper aware of match_reports ---------------------------
-- Same reaper as before, plus a 30-day retention sweep for saved recaps so the table can't grow
-- without bound. Redefined in full because create-or-replace can't patch a function body.
create or replace function public.prune_stale_rooms()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  with activity as (
    select
      r.id,
      r.status,
      greatest(
        r.created_at,
        coalesce((select max(a.created_at) from attacks a where a.room_id = r.id), r.created_at),
        coalesce((select max(p.joined_at)  from players p where p.room_id = r.id), r.created_at)
      ) as last_active
    from rooms r
  ),
  dead as (
    delete from rooms r
    using activity act
    where act.id = r.id
      and act.last_active < case
            when act.status = 'finished' then now() - interval '10 minutes'
            else now() - interval '1 hour'
          end
    returning 1
  )
  select count(*) into removed from dead;

  delete from match_reports where finished_at < now() - interval '30 days';

  return removed;
end;
$$;

revoke all on function public.prune_stale_rooms() from public;
