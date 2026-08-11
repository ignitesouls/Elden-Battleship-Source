import { supabase, ensureSignedIn } from "./supabase";
import { MATCH_START_MARKER } from "./matchTime";
import { initialHitsRemaining, emptyGrid } from "./battleshipLogic";
import { generateRoomCode, normalizeRoomCode, formatRoomCode, generateRejoinCode, generateSeed } from "./roomCode";
import { storePlayerId } from "./playerSession";
import type { CLASSIC_SHIPS } from "../types/battleship";
import type { Room, Player, Fleet, ShipPlacement, ShipDefinition } from "../types/battleship";

export interface RoomOptions {
  startingSeconds?: number;
  prepSeconds?: number;
}

export async function createRoom(
  nickname: string,
  boardSize: number,
  shipDefs: typeof CLASSIC_SHIPS,
  options: RoomOptions = {}
): Promise<{ room: Room; player: Player }> {
  const userId = await ensureSignedIn();

  let room: Room | null = null;
  // Retry on the (rare) chance of a room-code collision.
  for (let attempt = 0; attempt < 5 && !room; attempt++) {
    // Pass the attempt so repeated collisions escalate to a numeric-suffixed code.
    const code = generateRoomCode(attempt);
    const payload: Record<string, unknown> = {
      code,
      board_size: boardSize,
      ship_defs: shipDefs,
      seed: generateSeed(),
    };
    if (options.startingSeconds !== undefined) payload.starting_seconds = options.startingSeconds;
    if (options.prepSeconds !== undefined) payload.prep_seconds = options.prepSeconds;

    const { data, error } = await supabase.from("rooms").insert(payload).select().single();
    if (!error) {
      room = data as Room;
      break;
    }
    if (error.code === "23505") continue; // room-code collision, try another

    // These columns arrive with later migrations; on a project that hasn't applied them yet,
    // retry without them so room creation still works (rooms just use the defaults, and the seed
    // can be rolled from the lobby afterwards).
    if (/starting_seconds|prep_seconds|seed/i.test(error.message)) {
      const { data: retry, error: retryErr } = await supabase
        .from("rooms")
        .insert({ code, board_size: boardSize, ship_defs: shipDefs })
        .select()
        .single();
      if (retryErr) throw retryErr;
      room = retry as Room;
      break;
    }
    throw error;
  }
  if (!room) throw new Error("Could not allocate a room code, please try again.");

  const { data: player, error: playerError } = await supabase
    .from("players")
    .insert({ room_id: room.id, user_id: userId, nickname, is_host: true, team: null })
    .select()
    .single();
  if (playerError) throw playerError;

  storePlayerId(room.code, player.id);
  await ensureRejoinCode(player as Player);
  return { room, player: player as Player };
}

/**
 * Gives a player row a rejoin code if it doesn't have one yet.
 *
 * Assigned once and never rotated - a code that changed on every reconnect would be useless as
 * the thing you write down. Silently no-ops when the column is missing (migration not applied),
 * so joining a room never fails over a recovery convenience.
 */
async function ensureRejoinCode(player: Player): Promise<string | null> {
  if (player.rejoin_code) return player.rejoin_code;
  const code = generateRejoinCode();
  const { error } = await supabase.from("players").update({ rejoin_code: code }).eq("id", player.id);
  if (error) return null;
  player.rejoin_code = code;
  return code;
}

/**
 * Takes over an existing player row using its rejoin code, recovering the team and fleet that
 * belonged to it. Returns the player id, or null if the code doesn't match anything here.
 */
export async function redeemRejoinCode(roomCode: string, rejoinCode: string): Promise<string | null> {
  await ensureSignedIn();
  const { data, error } = await supabase.rpc("claim_player_slot", {
    p_room_code: normalizeRoomCode(roomCode),
    p_rejoin_code: rejoinCode.trim().toUpperCase(),
  });
  if (error) throw error;
  if (!data) return null;
  storePlayerId(normalizeRoomCode(roomCode), data as string);
  return data as string;
}

export async function joinRoom(code: string, nickname: string): Promise<{ room: Room; player: Player }> {
  const userId = await ensureSignedIn();

  // Normalized, not just uppercased: a code read aloud gets typed back as "salty kraken" or
  // "Salty-Kraken" just as often as the stored "SALTYKRAKEN", and all of those must resolve.
  const lookup = normalizeRoomCode(code);
  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select()
    .eq("code", lookup)
    .maybeSingle();
  if (roomError) throw roomError;
  if (!room) throw new Error(`No room found with code ${formatRoomCode(lookup)}`);

  // Look before writing. This used to be a blind upsert including `team: null, is_host: false`,
  // which meant re-entering a room you were already in silently reset your fleet choice and
  // stripped your host status - the exact situation this path exists to recover from. Rejoining
  // now only refreshes the nickname and leaves everything you'd already earned alone.
  const { data: existing } = await supabase
    .from("players")
    .select()
    .eq("room_id", room.id)
    .eq("user_id", userId)
    .maybeSingle();

  let player: Player;
  if (existing) {
    const { data: updated, error: updateErr } = await supabase
      .from("players")
      .update({ nickname })
      .eq("id", existing.id)
      .select()
      .single();
    if (updateErr) throw updateErr;
    player = updated as Player;
  } else {
    const { data: inserted, error: insertErr } = await supabase
      .from("players")
      .insert({ room_id: room.id, user_id: userId, nickname, team: null, is_host: false })
      .select()
      .single();
    if (insertErr) throw insertErr;
    player = inserted as Player;
  }

  storePlayerId(room.code, player.id);
  await ensureRejoinCode(player);
  return { room: room as Room, player };
}

/**
 * Moves a player to a fleet (or to spectating).
 *
 * Stamps team_joined_at, which is what decides captaincy - earliest pick on a team runs it. Set
 * fresh on every change rather than only the first, so leaving a fleet and coming back puts you at
 * the back of the queue instead of letting you reclaim command by bouncing out and in.
 */
export async function setPlayerTeam(playerId: string, team: number | null): Promise<void> {
  const patch: Record<string, unknown> = { team, team_joined_at: team === null ? null : new Date().toISOString() };
  const { error } = await supabase.from("players").update(patch).eq("id", playerId);

  // Pre-migration projects don't have the column; the team change itself still matters.
  if (error && /team_joined_at/i.test(error.message)) {
    const { error: retry } = await supabase.from("players").update({ team }).eq("id", playerId);
    if (retry) throw retry;
    return;
  }
  if (error) throw error;
}

/**
 * Renames one team. Offered only to the host in the UI; RLS additionally requires the caller to
 * be a player in this room (it used to allow literally anyone - see the lock_down_writes migration).
 *
 * Read-modify-write on a jsonb array, so it reads the current value first rather than assuming
 * what's in local state. A blank name clears the override and the team falls back to its color
 * name, which is also how you undo a rename.
 */
export async function setTeamName(roomId: string, team: number, name: string): Promise<void> {
  const { data: room, error: readErr } = await supabase
    .from("rooms")
    .select("team_names")
    .eq("id", roomId)
    .single();
  if (readErr) throw readErr;

  const names: (string | null)[] = Array.isArray(room?.team_names) ? [...room.team_names] : [];
  // Pad rather than assign past the end: a sparse JS array serializes to nulls anyway, but going
  // through jsonb round-trips holes into `null` inconsistently across drivers.
  while (names.length <= team) names.push(null);
  const trimmed = name.trim().slice(0, 24);
  names[team] = trimmed.length > 0 ? trimmed : null;

  const { error } = await supabase.from("rooms").update({ team_names: names }).eq("id", roomId);
  if (error) throw error;
}

/**
 * Rolls a fresh randomizer seed for the room, on demand.
 *
 * Returning to the lobby now rolls one automatically (see resetRoomToLobby) - a second match on the
 * previous match's seed means replaying the same randomized world, which nobody wanted. This button
 * stays for rolling again within a lobby: the host reads the number out, somebody doesn't like it,
 * or a late joiner needs one before anyone has set their game up.
 */
export async function rerollSeed(roomId: string): Promise<string> {
  const seed = generateSeed();
  const { error } = await supabase.from("rooms").update({ seed }).eq("id", roomId);
  if (error) throw error;
  return seed;
}

export interface RoomSettings {
  board_size?: number;
  ship_defs?: ShipDefinition[];
  prep_seconds?: number;
  square_set?: string;
}

/**
 * Changes the match settings on an existing room. Lobby only, and only offered to the host.
 *
 * These used to be fixed at creation from the front page, which meant getting the board size wrong
 * cost you the room and everyone in it. RLS allows any player in the room to write `rooms`, so the
 * host-only part is the UI's doing - the same arrangement as starting the match.
 *
 * Board size and fleet changes leave every fleet row the wrong shape. That is deliberately NOT
 * repaired here: RLS scopes fleet writes to the owning team, so a host physically cannot rebuild
 * anyone else's. Each client notices the mismatch and resets its own (see useRoom's self-heal).
 */
export async function updateRoomSettings(roomId: string, settings: RoomSettings): Promise<void> {
  const { error } = await supabase.from("rooms").update(settings).eq("id", roomId);
  if (!error) return;

  // The square_set column arrives with a migration; say so plainly rather than surfacing a raw
  // PostgREST error, because the fix is a SQL paste and nothing else in the lobby is broken.
  if (/square_set/i.test(error.message)) {
    throw new Error(
      "This project hasn't had the square-set migration applied yet, so the square set can't be " +
        "changed. Run supabase/migrations/20260729000000_square_set.sql in the SQL editor."
    );
  }
  throw error;
}

/**
 * Renames a player - yourself, or anyone in the room if you're the host.
 *
 * Checks the RETURNED ROWS, not just `error`. RLS makes an UPDATE with no matching policy affect
 * zero rows and report NO error, so a host renaming a crewmate with the "players update by host"
 * policy missing looked exactly like a success and silently did nothing - which is precisely how
 * this shipped. Same failure mode the attack-log delete in resetRoomToLobby guards against, and the
 * same reason the kick button was broken before "players delete by host" existed.
 */
export async function renamePlayer(playerId: string, nickname: string): Promise<void> {
  const { data, error } = await supabase
    .from("players")
    .update({ nickname })
    .eq("id", playerId)
    .select("id");
  if (error) throw error;
  if ((data ?? []).length === 0) {
    throw new Error(
      "The database refused that rename. If you're renaming someone else, the room needs the " +
        '"players update by host" policy - see supabase/migrations/20260803010000_host_can_rename_players.sql.'
    );
  }
}

/** Host-only: removes another player from the room. RLS enforces the caller is actually the host. */
export async function kickPlayer(playerId: string): Promise<void> {
  const { data, error } = await supabase.from("players").delete().eq("id", playerId).select("id");
  if (error) throw error;
  if ((data ?? []).length === 0) {
    throw new Error(
      "The database refused that kick - it removed nobody. The room needs the " +
        '"players delete by host" policy; see supabase/migrations/20260803010000_host_can_rename_players.sql.'
    );
  }
}

/**
 * Leaves the room for good, deleting the player row.
 *
 * Deleting rather than just navigating away matters: it's what lets ensure_room_host() notice
 * the room has lost its host and promote someone else. A host who merely closes the tab leaves
 * their row (and their hosting) behind, which is what the presence-gated takeover is for.
 */
export async function leaveRoom(playerId: string): Promise<void> {
  const { error } = await supabase.from("players").delete().eq("id", playerId);
  if (error) throw error;
}

/** Takes over hosting. The UI only offers this when presence shows the current host offline. */
export async function claimHost(playerId: string): Promise<void> {
  const { error } = await supabase.rpc("claim_room_host", { p_player_id: playerId });
  if (error) throw error;
}

/** Creates the fleet row for a team if it doesn't exist yet. Safe to call repeatedly. */
export async function ensureFleet(room: Room, team: number): Promise<void> {
  const totalCells = room.board_size * room.board_size;
  const row = {
    room_id: room.id,
    team,
    ship_grid: emptyGrid(totalCells, false),
    ship_index_grid: emptyGrid(totalCells, -1),
    ship_hits_remaining: initialHitsRemaining(room.ship_defs),
    ship_sunk: emptyGrid(room.ship_defs.length, false),
    placements: null,
    placement_confirmed: false,
  };
  const { error } = await supabase
    .from("fleets")
    .upsert(row, { onConflict: "room_id,team", ignoreDuplicates: true });
  if (error) throw error;
}

/**
 * Writes a team's confirmed layout, and re-seeds its hit counters from the room's CURRENT fleet.
 *
 * The counters are rewritten here rather than only on the grids because this is the last moment
 * before the shooting starts and the first one where the layout and the ship list are certainly the
 * same generation. The lobby's self-heal is the other half of this and normally gets there first,
 * but it is a per-client effect that has to observe the change to act on it - so a client that was
 * mid-navigation, asleep in a background tab, or simply not looking at the lobby when the host
 * switched preset never ran it, and the stale counters survived into battle.
 *
 * Resetting them is unconditional and safe: nothing has been fired at a fleet that is still being
 * placed, so the pristine array is what the row should hold anyway.
 */
export async function submitPlacement(
  roomId: string,
  team: number,
  shipGrid: boolean[],
  shipIndexGrid: number[],
  placements: ShipPlacement[],
  shipDefs: ShipDefinition[]
): Promise<void> {
  const { error } = await supabase
    .from("fleets")
    .update({
      ship_grid: shipGrid,
      ship_index_grid: shipIndexGrid,
      placements,
      ship_hits_remaining: initialHitsRemaining(shipDefs),
      ship_sunk: emptyGrid(shipDefs.length, false),
    })
    .eq("room_id", roomId)
    .eq("team", team);
  if (error) throw error;
}

export async function confirmPlacement(roomId: string, team: number, confirmed: boolean): Promise<void> {
  const { error: fleetErr } = await supabase
    .from("fleets")
    .update({ placement_confirmed: confirmed })
    .eq("room_id", roomId)
    .eq("team", team);
  if (fleetErr) throw fleetErr;

  const { error: readyErr } = await supabase
    .from("team_ready")
    .upsert({ room_id: roomId, team, ready: confirmed }, { onConflict: "room_id,team" });
  if (readyErr) throw readyErr;
}

// Defined in matchTime.ts (see the note there); re-exported so callers can keep importing it
// from the rooms module alongside startBattle().
export { MATCH_START_MARKER };

export async function startBattle(roomId: string): Promise<void> {
  // Hide everything in the water before anyone can shoot at it (see lib/deepWater.ts). This is the
  // only moment it can happen: every fleet is confirmed, so the squares no fleet occupies are
  // finally a fixed set, and nothing has been fired at yet, so no square has been claimed as water.
  //
  // Postgres does the picking because it is the only participant allowed to see every fleet - the
  // whole reason this stopped being a client-side computation. Best-effort: a project that hasn't
  // run the migration gets a match with nothing hiding in it, which is a poorer match but a working
  // one, and is a much better failure than a room that cannot start.
  const { error: deepErr } = await supabase.rpc("roll_deep_water", { p_room_id: roomId });
  if (deepErr) {
    console.warn(
      "Nothing was hidden in the water for this match. Run supabase/migrations/" +
        "20260806000000_deep_water_hides.sql in your Supabase SQL editor.",
      deepErr
    );
  }

  // Written before the status flip so no client can enter 'battle' and find no clock. Checked
  // (not fire-and-forget) because an RLS rejection here used to fail silently - see the
  // "attacks insert start marker" policy - leaving every client stuck with no STARTING/
  // PREPARATION/MATCH anchor until the first real shot landed.
  const { error: markerErr } = await supabase.from("attacks").insert({
    room_id: roomId,
    cell_index: MATCH_START_MARKER,
    attacker_team: -1,
    defender_team: -1,
  });
  if (markerErr) throw markerErr;

  const { error } = await supabase.from("rooms").update({ status: "battle" }).eq("id", roomId);
  if (error) throw error;
}

export async function beginPlacementPhase(roomId: string): Promise<void> {
  const { error: roomErr } = await supabase.from("rooms").update({ status: "placement" }).eq("id", roomId);
  if (roomErr) throw roomErr;

  const { error: readyErr } = await supabase.from("team_ready").delete().eq("room_id", roomId);
  if (readyErr) throw readyErr;
}

/**
 * Fires at one coordinate. Mirrors the desktop app: a single shot lands on every OTHER
 * active team's board at that cell simultaneously, not just one chosen opponent.
 */
export async function sendAttack(
  roomId: string,
  cellIndex: number,
  attackerTeam: number,
  defenderTeams: number[],
  attackerPlayerId: string
): Promise<void> {
  const base = defenderTeams
    .filter((t) => t !== attackerTeam)
    .map((defenderTeam) => ({
      room_id: roomId,
      cell_index: cellIndex,
      attacker_team: attackerTeam,
      defender_team: defenderTeam,
    }));
  if (base.length === 0) return;

  const { error } = await supabase
    .from("attacks")
    .insert(base.map((r) => ({ ...r, attacker_player_id: attackerPlayerId })));
  if (!error) return;

  // Firing must never hard-fail just because the feed migration hasn't been applied yet:
  // fall back to an un-attributed shot, which plays identically (the feed just shows the
  // team name instead of the player's).
  const missingColumn = /attacker_player_id/i.test(error.message);
  if (!missingColumn) throw error;

  const { error: retryError } = await supabase.from("attacks").insert(base);
  if (retryError) throw retryError;
}

/**
 * Resets a team's OWN fleet + ready row. Called by each client for its own team when it sees
 * the room drop back to 'lobby' - deliberately not done centrally by the host, because RLS
 * scopes `fleets` and `team_ready` writes to the owning team. A host-driven loop silently
 * wrote zero rows for every team but their own, which is why "End match" only ever appeared
 * to reset the host's board.
 */
export async function resetOwnTeamState(room: Room, team: number): Promise<void> {
  const totalCells = room.board_size * room.board_size;

  const { error: fleetErr } = await supabase
    .from("fleets")
    .update({
      ship_grid: emptyGrid(totalCells, false),
      ship_index_grid: emptyGrid(totalCells, -1),
      ship_hits_remaining: initialHitsRemaining(room.ship_defs),
      ship_sunk: emptyGrid(room.ship_defs.length, false),
      placements: null,
      placement_confirmed: false,
    })
    .eq("room_id", room.id)
    .eq("team", team);
  if (fleetErr) throw fleetErr;

  // Update rather than delete: the per-team update policy exists, a delete policy may not.
  const { error: readyErr } = await supabase
    .from("team_ready")
    .upsert({ room_id: room.id, team, ready: false, eliminated: false }, { onConflict: "room_id,team" });
  if (readyErr) throw readyErr;
}

export async function resetRoomToLobby(roomId: string, activeTeamsList: number[] = []): Promise<void> {
  const { data: room } = await supabase.from("rooms").select().eq("id", roomId).single();

  // Deliberately does NOT archive first. A match abandoned part-way through isn't a result, and
  // recording it would pollute career records with half-played games - so ending early bins the
  // whole thing. Archiving happens only when a match actually reaches its conclusion, from the
  // post-match report screen. "Play again" from that screen is therefore safe: the report has
  // already rendered and saved by the time anyone can click it.

  // Clear the shared attack log first, so no stale hit/miss markers survive into the next match.
  //
  // This must check the RETURNED ROWS, not just `error`: Postgres RLS makes a DELETE with no
  // matching policy affect zero rows and report NO error at all. Checking only `error` made a
  // completely blocked delete look like a success, which is why "End match" appeared to work
  // but left the previous match's hits on the board.
  const { data: remainingBefore } = await supabase.from("attacks").select("id").eq("room_id", roomId).limit(1);
  const hadAttacks = (remainingBefore ?? []).length > 0;

  const { data: deleted, error: attacksErr } = await supabase
    .from("attacks")
    .delete()
    .eq("room_id", roomId)
    .select("id");
  if (attacksErr) throw attacksErr;

  if (hadAttacks && (deleted ?? []).length === 0) {
    throw new Error(
      "Can't clear the previous match's shots: the database is rejecting the delete. " +
        "Run this once in your Supabase SQL editor:\n\n" +
        'create policy "attacks delete" on attacks for delete using (true);'
    );
  }

  // Shared square tallies belong to the match that was just abandoned, so they go with it.
  //
  // Deliberately unchecked, unlike the attack log above: `square_counts` is optional (see
  // RUN_THESE.sql) and a room whose host hasn't run that migration would otherwise be unable to
  // end a match at all. Leftover counts are a cosmetic annoyance; a reset that throws is not.
  await supabase.from("square_counts").delete().eq("room_id", roomId);

  // The last match's hiding places go with its attack log, and for a sharper reason than the tallies
  // above: those squares were chosen against fleets that are about to be wiped and re-placed, so
  // keeping them would put a creature under somebody's new hull. startBattle rolls fresh ones.
  //
  // Unchecked, like square_counts and for the same reason - an un-migrated project must still be able
  // to end a match. It cannot leave stale rows behind either way: roll_deep_water clears the room
  // before it inserts.
  await supabase.from("deep_hides").delete().eq("room_id", roomId);

  // Best-effort: reset any team's fleet we're actually allowed to write (our own, plus every
  // team if the optional host policies are installed). Each client also self-heals on seeing
  // 'lobby', so teams we can't touch here clean themselves up.
  if (room) {
    for (const team of activeTeamsList) {
      await supabase
        .from("fleets")
        .update({
          ship_grid: emptyGrid(room.board_size * room.board_size, false),
          ship_index_grid: emptyGrid(room.board_size * room.board_size, -1),
          ship_hits_remaining: initialHitsRemaining(room.ship_defs),
          ship_sunk: emptyGrid(room.ship_defs.length, false),
          placements: null,
          placement_confirmed: false,
        })
        .eq("room_id", roomId)
        .eq("team", team);
      await supabase
        .from("team_ready")
        .update({ ready: false, eliminated: false })
        .eq("room_id", roomId)
        .eq("team", team);
    }
  }

  // A fresh seed for the next match, rolled in the same write as the status flip so there is no
  // moment where the lobby is open on the match everyone has just played. Both routes back to the
  // lobby come through here - "Play again" off the report, and the host's "End match" - and both
  // mean the next game, so both get a new world.
  //
  // Written even if the column doesn't exist yet on an un-migrated project? No: that would fail the
  // whole reset. Retry without it instead, because getting everyone back to the lobby matters more
  // than the seed.
  const patch = { status: "lobby", winner_team: null, seed: generateSeed() };
  const { error: roomErr } = await supabase.from("rooms").update(patch).eq("id", roomId);
  if (roomErr) {
    if (!/seed/i.test(roomErr.message)) throw roomErr;
    const { error: retryErr } = await supabase
      .from("rooms")
      .update({ status: "lobby", winner_team: null })
      .eq("id", roomId);
    if (retryErr) throw retryErr;
  }
}

/**
 * Reads the saved recaps. Writing them is the `archive_match` RPC's job now - see
 * lib/archiveMatch.ts - because the old client-side insert path let anyone forge records.
 */
export async function fetchRecentMatchReports(limit = 8) {
  const { data, error } = await supabase
    .from("match_reports")
    .select()
    .order("finished_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return data ?? [];
}

export type { Room, Player, Fleet };
