-- A caster's switch: no find alerts on the players' own streams in this lobby.
--
-- In a cast match the caster's scene already puts every find over the board, and the caster's
-- scene also shows each player's stream in a box - so a player who ticked "Find alerts" in their
-- own scene has the same card burst over their gameplay inside the broadcast, a second copy of
-- what the board is already showing. This flag makes the players' alert sources stay empty for the
-- room, whatever each of them ticked. The caster's own alert is unaffected: it is told apart by the
-- token's owner having no fleet (see StreamSource and OverlayEgg), not by anything stored here.
--
-- Per room, not per match: a lobby that is being cast stays cast across its rematches.

alter table public.rooms add column if not exists find_alerts_off boolean not null default false;

-- -- Who may flip it ------------------------------------------------------------------------------
--
-- Anyone signed in who is IN the room, spectators included, plus admins. That is a deliberate
-- exception to "a spectator may read everything and change nothing" (spectators_cannot_disrupt),
-- and it is safe to make for this one column: there is no caster role in the schema - a caster is a
-- spectator - and the worst a stranger can do with it is hide the players' alert cards, which
-- changes nothing about the match and which anyone in the room can flip straight back.
--
-- A definer function rather than a widened update policy, because a policy cannot be scoped to one
-- column: opening "rooms update" to spectators would hand them status, seed and board size again.
create or replace function public.set_find_alerts_off(p_room uuid, p_off boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to change this';
  end if;
  if not (
    exists (select 1 from players p where p.room_id = p_room and p.user_id = auth.uid())
    or public.is_admin()
  ) then
    raise exception 'Join the room to change this';
  end if;
  update rooms set find_alerts_off = coalesce(p_off, false) where id = p_room;
end;
$$;

revoke all on function public.set_find_alerts_off(uuid, boolean) from public, anon;
grant execute on function public.set_find_alerts_off(uuid, boolean) to authenticated;
