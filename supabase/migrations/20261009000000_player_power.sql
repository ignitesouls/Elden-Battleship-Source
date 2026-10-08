-- Team power: every player's power, stored once per archive change.
--
-- Tournament pages show a "power" for each team and a betting-style line on each match (see
-- src/lib/tournament/teamPower.ts). A player's power comes from replaying the whole archive (their Elo)
-- and from their battle ratings - the same full read the battle-ratings Edge Function already does when
-- the archive changes. So that function works the powers out in the same pass and stores them here, and
-- an event page asks it for its players' rows in one request rather than downloading the archive.
--
-- "Live", as the organisers asked: the function recomputes whenever the archive's fingerprint changes (a
-- match archived or voided, a shot edited, a formula deployed), so a power moves as soon as a game is
-- played - on the next request after it, not on a timer.
--
-- Keyed like a career: the account id, or name:<nickname> for a game played signed out.

create table if not exists public.player_power_snapshots (
  player_key  text primary key,
  -- The fingerprint of the archive these were computed from - the same value battle_rating_snapshots
  -- carries, written in the same transaction.
  fingerprint text not null,
  elo         double precision not null,
  games       int not null,
  -- The shrunk battle-rating average, or null for a player with no rated game.
  battle      double precision,
  power       double precision not null,
  computed_at timestamptz not null default now()
);

comment on table public.player_power_snapshots is
  'Each player''s team power, written and read only by the battle-ratings Edge Function. Safe to empty: the next request rebuilds it.';

-- Only the function touches it, connecting as the owner; nobody reads it over the API.
alter table public.player_power_snapshots enable row level security;
revoke all on public.player_power_snapshots from anon, authenticated;
