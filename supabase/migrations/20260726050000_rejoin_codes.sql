-- Portable player identity, so a cleared cache or a different device doesn't cost you your fleet.
--
-- Identity today is an anonymous Supabase auth session living in localStorage, and player rows
-- are keyed on that user_id. Clear site data, switch browser, or pick the match back up on a
-- laptop and you come back as a brand-new user: no team, no ships, while your original row sits
-- there still holding the fleet you placed. There's currently no way back into it.
--
-- A rejoin code is a per-player bearer token that re-points an existing player row at whoever
-- redeems it. Deliberately NOT an account: no email, no password, nothing to reset. Anyone holding
-- the code can take that slot. It is a bearer token by design, scoped to a single room, and there
-- is nothing more to the security model than that.
alter table players add column if not exists rejoin_code text;

create index if not exists players_rejoin_code_idx on players (room_id, rejoin_code);

-- Redeems a code: hands the caller ownership of that player row.
--
-- SECURITY DEFINER because the caller does NOT yet own the row - the "players update own"
-- policy would reject this by definition, since proving you should own it is the entire point
-- of the call.
create or replace function public.claim_player_slot(p_room_code text, p_rejoin_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   uuid;
  v_room uuid;
begin
  if p_rejoin_code is null or length(trim(p_rejoin_code)) = 0 then
    return null;
  end if;

  select p.id, p.room_id into v_id, v_room
    from players p
    join rooms r on r.id = p.room_id
   where upper(r.code) = upper(p_room_code)
     and upper(p.rejoin_code) = upper(trim(p_rejoin_code))
   limit 1;

  if v_id is null then return null; end if;

  -- players has unique (room_id, user_id): if this browser already holds a different slot in
  -- the same room, taking over would violate it. Drop the throwaway row we're abandoning - it
  -- is the identity being replaced, not one anybody is still using.
  delete from players
   where room_id = v_room
     and user_id = auth.uid()
     and id <> v_id;

  update players set user_id = auth.uid() where id = v_id;
  return v_id;
end;
$$;

grant execute on function public.claim_player_slot(text, text) to anon, authenticated;
