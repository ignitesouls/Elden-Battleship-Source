-- Records WHO fired each shot (not just which team), so the battle feed can show
-- "Alice fired at C4 - HIT". Nullable + on delete set null so shots outlive the player
-- leaving the room, and so rows created before this column still load fine.
alter table attacks
  add column if not exists attacker_player_id uuid references players(id) on delete set null;
