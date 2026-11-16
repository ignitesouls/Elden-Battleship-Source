-- ===========================================================================
--  An official match never starts on an undealt board
-- ===========================================================================
-- startBattle() already holds an official match in placement when balance-board could not deal its
-- board (see BoardNotDealtError in lib/rooms.ts). This is the backstop, for the same reason
-- guard_battle_start backs up the unplaced-fleet check: a host on an old tab, or one who skips the
-- client, would otherwise start the match on the raw seeded deal.
--
-- Only the sets balance-board deals (BOSS_SETS there; null is a room from before square sets, which
-- is the default `bosses`). Any other set has nothing to balance, and refusing it would lock the room.
--
-- A board that balance-board dealt but could not make pass every test - the "fairest miss" - is not
-- refused here, because balance-board no longer writes one for an official match (it answers
-- `no_fair_board` instead). Refusing it here would lock the room for good: a written board_perm is
-- what balance-board reads as `already_balanced`, so nothing could re-deal it.
--
-- deal_failed_at is the other half: the host stamps it when a deal fails, so every crew's placement
-- screen can say the match is waiting on a re-deal rather than still claiming it is being dealt. It
-- describes one failed deal, so it is cleared here the moment a board is dealt or the room leaves
-- placement - no client has to remember to.

alter table public.rooms add column if not exists deal_failed_at timestamptz;

comment on column public.rooms.deal_failed_at is
  'When the host''s last attempt to deal this official match''s board failed. Cleared automatically once a board is dealt or the room leaves placement. Display only.';

-- Not security definer, like guard_battle_start, so current_user is the caller.
create or replace function public.guard_official_board()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.deal_failed_at is not null
     and (new.board_perm is not null or new.status is distinct from 'placement') then
    new.deal_failed_at := null;
  end if;

  -- Only the moment of entering battle.
  if new.status is distinct from 'battle' or old.status is not distinct from 'battle' then
    return new;
  end if;

  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if new.tournament_match_id is null
     or coalesce(new.square_set, 'bosses') not in ('bosses', 'bosses-2v2')
     or new.board_perm is not null then
    return new;
  end if;

  raise exception 'This official match''s board has not been dealt fairly yet, so it cannot start - deal again';
end;
$$;

drop trigger if exists rooms_guard_official_board on public.rooms;
create trigger rooms_guard_official_board
  before update on public.rooms
  for each row execute function public.guard_official_board();
