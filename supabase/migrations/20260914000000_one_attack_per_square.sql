-- One row per fleet per square: make the "already fired here" check airtight at the database,
-- not just in the two callers that currently do it themselves.
--
-- The bug: a fleet only gets to fire at a given square once (see check-double-shots.mjs and the
-- 20260803 migration for why - resolve_attack() already treats a second row at a settled square
-- as a copy of the first verdict, precisely so a repeat can never wound a hull twice). But nothing
-- ever stopped that second row from being INSERTED. Both callers - the client's sendAttack() and
-- the auto-fire edge function - decide "have I already fired here" by reading `attacks` fresh and
-- then inserting, which is a check-then-act race: a second request that reads before the first
-- request's row has committed sees no prior shot and inserts a real duplicate.
--
-- That race is rare for a manual click (the client's own firedRef guard mostly covers the gap
-- before realtime echoes a row back - see BattlePhase.tsx), but routine for auto-fire: the native
-- mod deliberately resends every currently-set kill flag on every poll rather than only the newest
-- one, "so a dropped request, a network blip or the mod restarting mid-match all heal on the next
-- send" (see the auto-fire function's own header comment). Every kill each poll re-reports is
-- another chance for that poll's request to race one still in flight from the poll before it,
-- since each kill in a request does a synchronous insert-then-resolve before the next kill in the
-- same request is even looked at. A live match (SUNKENCORSAIR, archived 2026-09-14) shows exactly
-- this: one player's scoreboard read 94 shots while the durable match_events log - which happens to
-- dedupe on (match_key, nickname, cell_index) - only has 28 rows for them. 66 of that player's
-- "shots" were repeat fire at squares they had already shot, landing as extra rows nobody's
-- application-level check caught.
--
-- The fix is the same shape as resolve_attack's own idempotency, one layer down: let Postgres
-- reject the second row outright rather than trusting every caller to check first and never race.
-- attacker_player_id is deliberately NOT part of the key - firing is a fleet-level fact (two
-- crewmates racing to click the same square are still only owed one shot between them), matching
-- both the client's own guard (BattlePhase.tsx filters `outgoing` by attacker_team, not player) and
-- resolve_attack's reading of "already settled".
--
-- No existing data conflicts with this: no room is currently live, so there is nothing to clean up
-- before the index can be created.
create unique index if not exists attacks_one_shot_per_square
  on attacks (room_id, attacker_team, defender_team, cell_index);

comment on index attacks_one_shot_per_square is
  'One attacks row per fleet per square per opposing fleet - including the match-start marker
   (attacker_team = defender_team = cell_index = -1), which is exactly why callers now insert it
   with on conflict do nothing instead of a bare insert: startBattle() is documented to tolerate a
   duplicate caller, and a bare insert against this index would turn that into a hard error.';
