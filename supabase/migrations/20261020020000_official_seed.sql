-- Official matches are dealt only from vetted boss pools.
--
-- The seed decides which bosses a board deals (with the room id), and the balancer can only move
-- them around afterwards. So for an official match the seed is drawn by the official-seed Edge
-- Function, which keeps rolling until the pool's cost spread is under the cutoff for its board -
-- see src/lib/officialPool.ts. Postgres cannot do the drawing: the deal is a TypeScript function
-- every client re-derives, and a plpgsql copy would be a second source of truth.
--
-- What Postgres does do is hold the line:
--
--   * `official_seed` is the seed official-seed vetted. Only the server writes it.
--   * Any other write that changes the seed, the board size or the square set clears it, so a
--     vetted seed can never describe a board other than the one it was vetted for. That covers the
--     reset into the next game of a series (resetRoomToLobby rolls a fresh seed from the host's
--     browser) and link_official_room applying the event's square set.
--   * In an official lobby a browser may not reroll the seed at all. Before this, any seated player
--     could, and since the deal is computable in a browser, could keep rolling until the bosses
--     suited their team.
--   * An official boss room cannot leave the lobby until `official_seed = seed`.
--
-- Only the two boss cuts are vetted - the sets with costs, and the same two the balancer works on.
-- Boss Shuffle and the objective sets start as they always have.
--
-- No backfill: null is "not vetted", which is the truth for every room today. An official room
-- sitting in its lobby right now will be vetted by the host's lobby the moment the new site loads.

alter table public.rooms add column if not exists official_seed text;

create or replace function public.guard_official_room()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  server boolean := current_user in ('service_role', 'postgres', 'supabase_admin');
begin
  -- -- official_seed: written by the server, and only ever describes the board it was drawn for ---
  -- Ahead of the server's early return below, because the clearing has to apply to the server's own
  -- functions too: link_official_room can change the square set, and a seed vetted for one set says
  -- nothing about another.
  if tg_op = 'INSERT' then
    if not server and new.official_seed is not null then
      raise exception 'An official match''s seed is drawn by the server, not set directly';
    end if;
  else
    if not server and new.official_seed is distinct from old.official_seed then
      raise exception 'An official match''s seed is drawn by the server, not set directly';
    end if;
    if new.official_seed is not distinct from old.official_seed
       and (new.seed is distinct from old.seed
            or new.board_size is distinct from old.board_size
            or new.square_set is distinct from old.square_set) then
      new.official_seed := null;
    end if;
  end if;

  if server then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.tournament_match_id is not null or new.official_a_confirmed or new.official_b_confirmed
       or new.official_team_a is not null or new.official_team_b is not null then
      raise exception 'A room becomes an official match through the official match controls, not directly';
    end if;
    return new;
  end if;

  if new.tournament_match_id is distinct from old.tournament_match_id
     or new.official_a_confirmed is distinct from old.official_a_confirmed
     or new.official_b_confirmed is distinct from old.official_b_confirmed
     or new.official_team_a is distinct from old.official_team_a
     or new.official_team_b is distinct from old.official_team_b then
    raise exception 'A room becomes an official match through the official match controls, not directly';
  end if;

  if old.tournament_match_id is null then
    return new;
  end if;

  -- From here the room IS official.
  if new.board_size is distinct from old.board_size
     or new.ship_defs is distinct from old.ship_defs
     or new.starting_seconds is distinct from old.starting_seconds
     or new.prep_seconds is distinct from old.prep_seconds
     or new.square_set is distinct from old.square_set then
    raise exception 'This is an official match - its settings are fixed by the tournament';
  end if;

  if new.practice then
    raise exception 'An official match cannot be a practice match';
  end if;

  -- The lobby's reroll button. Rolling a seed on the way BACK to the lobby, from a finished game, is
  -- still allowed - that is the next game of the series getting a fresh world, and it arrives
  -- unvetted, so it cannot be played until the server has drawn a proper one.
  if old.status = 'lobby' and new.status = 'lobby' and new.seed is distinct from old.seed then
    raise exception 'This is an official match - its seed is drawn by the server, so it cannot be rerolled';
  end if;

  -- Leaving the lobby is the start of the match, and both teams have to have agreed to play it.
  if old.status = 'lobby' and new.status <> 'lobby'
     and not (old.official_a_confirmed and old.official_b_confirmed) then
    raise exception 'Both teams have to enter their entry codes before an official match can start';
  end if;

  -- And it has to be on a vetted pool. `old` rather than `new`: a start cannot smuggle a seed in.
  if old.status = 'lobby' and new.status <> 'lobby'
     and coalesce(old.square_set, 'bosses') in ('bosses', 'bosses-2v2')
     and (old.seed is null or old.official_seed is distinct from old.seed) then
    raise exception 'The official board has not been drawn yet - wait a moment for it, then start again';
  end if;

  return new;
end;
$$;
