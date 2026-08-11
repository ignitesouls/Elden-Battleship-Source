-- Lets a stream overlay read the fleet of the player who owns it.
--
-- An OBS Browser Source is a separate browser context with no saved session, so the overlay
-- authenticates as a brand-new anonymous user belonging to no team. Every "fleets select" policy
-- keys off membership, so RLS correctly returns nothing - which is exactly why the overlay has
-- only ever been able to show public data. A "spoiler" overlay that draws the streamer's own
-- ships therefore needs a way to prove which player it belongs to.
--
-- The proof is the player's existing rejoin_code, passed in the overlay URL. Same bearer-token
-- model as claim_player_slot: whoever holds the code can act as that player, scoped to one room.
-- This adds no exposure beyond what that function already grants - anyone with the code could
-- already take the slot outright, which is strictly worse than reading it.
--
-- CRITICAL: this is read-only, and must stay that way. The overlay cannot call
-- claim_player_slot() to identify itself, because that re-points the player row at the caller -
-- the streamer's own overlay would silently steal their seat out from under them mid-match.
create or replace function public.overlay_fleet(p_room_code text, p_rejoin_code text)
returns table (
  team                int,
  placements          jsonb,
  ship_sunk           jsonb,
  ship_hits_remaining jsonb,
  placement_confirmed boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Return an empty set rather than raising: a missing or stale code means "no spoiler data",
  -- and an overlay that errors out is a black rectangle on someone's stream.
  if p_rejoin_code is null or length(trim(p_rejoin_code)) = 0 then
    return;
  end if;

  return query
  select f.team, f.placements, f.ship_sunk, f.ship_hits_remaining, f.placement_confirmed
    from players p
    join rooms  r on r.id = p.room_id
    join fleets f on f.room_id = p.room_id and f.team = p.team
   where upper(r.code) = upper(p_room_code)
     and upper(p.rejoin_code) = upper(trim(p_rejoin_code))
     and p.team is not null
   limit 1;
end;
$$;

grant execute on function public.overlay_fleet(text, text) to anon, authenticated;
