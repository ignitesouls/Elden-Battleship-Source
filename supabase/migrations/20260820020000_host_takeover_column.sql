-- Host takeover has been throwing since 15 August: `players` has no `created_at`.
--
-- The column that records when somebody joined a room is `joined_at`, and always has been - see
-- the initial schema. `claim_room_host` was rewritten in 20260815010000_spectators_cannot_disrupt
-- to draw its line at arrival ("you may take over a room you were in BEFORE the match started"),
-- and it reached for the wrong name to do it. The whole function raises before it does anything,
-- so the takeover does not merely refuse - it errors out.
--
-- What that costs is precisely the situation the feature exists for. A host who drops leaves a room
-- nobody can end, restart or moderate, and the button offered to fix it has not worked for anyone
-- since the day the rule landed. Nothing else in the migration was wrong: the OTHER created_at in
-- here reads `attacks`, which does have one.
--
-- Only the one word changes. The arrival rule, the admin exemption, the no-host escape hatch and
-- the grant are all reproduced exactly as 20260815010000 wrote them.
create or replace function public.claim_room_host(p_player_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room    uuid;
  v_joined  timestamptz;
  v_started timestamptz;
begin
  -- joined_at, not created_at. This is the fix.
  select room_id, joined_at into v_room, v_joined
    from players
   where id = p_player_id and user_id = auth.uid();
  if v_room is null then return false; end if;

  -- cell_index = -1 is the match-start marker (MATCH_START_MARKER in lib/matchTime.ts). Null means
  -- no match has started in this room yet, so there is no "during" to have arrived in.
  select min(created_at) into v_started
    from attacks where room_id = v_room and cell_index = -1;

  if v_started is not null
     and v_joined > v_started
     and not public.is_admin()
     and exists (select 1 from players where room_id = v_room and is_host)
  then
    return false;
  end if;

  update players set is_host = false where room_id = v_room and is_host;
  update players set is_host = true  where id = p_player_id;
  return true;
end;
$$;

grant execute on function public.claim_room_host(uuid) to anon, authenticated;
