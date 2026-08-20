import { supabase, ensureSignedIn } from "./supabase";
import { MATCH_START_MARKER } from "./matchTime";
import { initialHitsRemaining, emptyGrid } from "./battleshipLogic";
import { teamName } from "./teamColors";
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

/**
 * Takes over hosting. The UI only offers this when presence shows the current host offline.
 *
 * Can be legitimately refused, which is why the returned flag is checked rather than only the
 * error. Since the front page started publishing live battles, the room can be joined by people it
 * has never met, and hosting is the key to every other host-only lock - so the function now grants
 * it only to someone who was in the room before the match started (see the
 * spectators_cannot_disrupt migration). A stranger who walked in mid-battle gets `false`.
 */
export async function claimHost(playerId: string): Promise<void> {
  const { data, error } = await supabase.rpc("claim_room_host", { p_player_id: playerId });
  if (error) throw error;
  if (data === false) {
    throw new Error(
      "Only someone who was already in this room when the match started can take over hosting."
    );
  }
}

/**
 * Captain-only: hands command of the fleet to a crewmate.
 *
 * Goes through an RPC rather than an update because it writes another player's row, which
 * "players update own" forbids from the browser. The function re-checks the caller is the current
 * captain and that the room is still in the lobby, so this is enforced, not merely unoffered.
 */
export async function handOverCaptaincy(targetPlayerId: string): Promise<void> {
  const { error } = await supabase.rpc("hand_over_captaincy", { p_target: targetPlayerId });
  if (!error) return;

  // PostgREST reports an unknown function as PGRST202. Named here, because the symptom before the
  // migration is run is a button that fails with "schema cache" and nothing that says why.
  if (error.code === "PGRST202" || /hand_over_captaincy/.test(error.message)) {
    throw new Error(
      "This room's database doesn't have the handover function yet - see " +
        "supabase/migrations/20260813000000_captain_handoff.sql."
    );
  }
  throw error;
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
  const { data, error } = await supabase
    .from("fleets")
    .update({
      ship_grid: shipGrid,
      ship_index_grid: shipIndexGrid,
      placements,
      ship_hits_remaining: initialHitsRemaining(shipDefs),
      ship_sunk: emptyGrid(shipDefs.length, false),
    })
    .eq("room_id", roomId)
    .eq("team", team)
    .select("team");
  if (error) throw error;

  // A layout that didn't land must never be confirmed. An UPDATE matching no row - because the
  // fleet row is missing, or because RLS rejected the write - returns neither an error nor a row,
  // and confirmPlacement() would then go on to raise the public ready flag over a fleet that isn't
  // there. That combination is the whole DEEPVOYAGE failure in miniature: ready, and empty.
  if ((data ?? []).length === 0) {
    throw new Error(
      "Your fleet wasn't saved: the database rejected the layout. Try again. If it keeps " +
        "happening, leave and rejoin the room to re-link your player row to this fleet."
    );
  }
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

/**
 * How long the board balancer gets before the room starts without it.
 *
 * Was 3s, on the reasoning that the work is a fraction of a millisecond and the rest is just
 * network. That stopped being true: the tests now bind on most boards, so the function draws up to
 * 300 layouts and declumps each one, which is 413ms of compute in the worst case. On top of that
 * sits a cold function boot - measured at 871ms - and half a dozen sequential queries inside it.
 * Three seconds was close enough to that total to be a coin toss, and losing the toss is silent.
 *
 * Ten seconds is long to watch, but the thing being waited for is the entire fairness of the match,
 * and a room that starts unbalanced cannot be fixed afterwards. balance-board also refuses to write
 * a layout once the room has left placement, so overshooting this timeout is now safe rather than
 * merely unlikely - see the `too_late` guard there.
 */
const BALANCE_TIMEOUT_MS = 10000;

/**
 * Finishes dealing the board against the fleets now standing on it.
 *
 * Both fleets are down and neither can move again, which makes this the only honest moment for it:
 * balance it any earlier and you are balancing against ships that can still be picked up, any later
 * and somebody has already fired at a square that is about to become a different square.
 *
 * Still best-effort in the sense that it never throws: a project with no balance-board deployed, an
 * unmigrated database or a function that hangs all end with board_perm null, and a room that cannot
 * start is much worse than a room with an unbalanced board.
 *
 * What it is no longer is SILENT. This used to swallow every outcome into a console line, and two
 * consecutive matches duly went out unbalanced - one of them visibly lopsided - without anyone
 * noticing until the board was on screen. The reason now comes back to the caller so the host can
 * be told, because an unbalanced match is a thing you want to know about before it is played, not
 * after somebody complains about the board.
 */
export interface BalanceOutcome {
  balanced: boolean;
  /** Why not, when it isn't. `already_balanced` is the one benign case - see startBattle. */
  reason?: string;
}

async function balanceBoardFor(roomId: string): Promise<BalanceOutcome> {
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), BALANCE_TIMEOUT_MS)
    );
    const { data, error } = await Promise.race([
      supabase.functions.invoke("balance-board", { body: { roomId } }),
      timeout,
    ]);
    // A non-2xx refusal - not_host, not_signed_in - arrives as an error rather than as data, so the
    // reason has to be dug out of the response body before it is lost.
    if (error) {
      const body = await (error as { context?: { json?: () => Promise<unknown> } }).context
        ?.json?.()
        .catch(() => null);
      const reason = (body as { reason?: string } | null)?.reason;
      return { balanced: false, reason: reason ?? (error as Error).message };
    }
    if (data && !data.balanced) return { balanced: false, reason: data.reason };
    return { balanced: true };
  } catch (err) {
    return { balanced: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function startBattle(roomId: string): Promise<BalanceOutcome> {
  // Before the balancer, the water and the clock marker - all three of which write something - so a
  // refused start leaves the room exactly as it found it. It is also the only order that makes the
  // check worth having: the balancer deals the board AGAINST the fleets standing on it, and a fleet
  // that isn't there is one the board was never balanced for.
  //
  // The database refuses this too (rooms_guard_battle_start), and that refusal is the one that
  // actually holds - the host cannot see other crews' fleets, so this call is asking Postgres, not
  // deciding. Doing it here as well is what turns a raised exception into a sentence naming who
  // everyone is waiting for.
  const unplaced = await unplacedFleets(roomId);
  if (unplaced && unplaced.length > 0) {
    const names = unplaced.map(teamName);
    const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    throw new Error(
      `${who} ${names.length === 1 ? "has" : "have"} not placed a fleet yet, so the match cannot start. ` +
        "A fleet with no ships on it cannot be hit, cannot be sunk and cannot lose."
    );
  }

  // Before anything else, and before the status flip, so no client can enter 'battle' and render
  // the unbalanced board for a frame. Awaited rather than fired off for the same reason.
  //
  // The outcome is returned rather than dropped, so the host learns that a match is about to be
  // played on an unbalanced board while there is still someone to tell. `already_balanced` is the
  // benign one - a duplicate caller, which startBattle explicitly tolerates.
  const balance = await balanceBoardFor(roomId);

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

  return balance;
}

/**
 * Opens placement, having first made every fleet row in the room a blank fleet for THIS board.
 *
 * The order matters, and it used to be the other way round.
 *
 * The status flip is what every client is watching for. Doing it first meant the room announced
 * "we are placing" while last round's `team_ready` rows were still standing - and the host's own
 * start-the-battle effect (Room.tsx) reads exactly those rows to decide whether everyone is ready.
 * Between the awaited flip and the awaited delete there is a realtime round trip and a React
 * render, which is more than enough: the host could see 'placement' with two stale ready flags and
 * open fire on a placement phase nobody had taken part in yet. Clearing first closes it - there is
 * no window in which the room is in placement and anybody is falsely ready.
 *
 * The fleet re-seed is the other half, and fixes a different hole in the same accident. Fleet rows
 * are stamped with the room's shape by ensureFleet() at the moment a player picks a colour, and the
 * host may change the board size or the preset long after that. The only self-heal for a misshapen
 * row lives in useRoom and only runs in 'lobby', so a crew that never re-placed carried a fleet
 * sized for the old board into the match - 196 cells and 13 hulls on a 10x10 board, in DEEPVOYAGE.
 * Re-seeding here means placement always begins from rows that match the room, for every team at
 * once, whether or not their client is awake to notice.
 *
 * Both writes happen while the room is still in 'lobby' deliberately: guard_fleet_placement refuses
 * a write to `placements` from anyone but that team's captain once the room says 'placement', and
 * the host is not the captain of anybody else's fleet.
 */
export async function beginPlacementPhase(room: Room): Promise<void> {
  const { error: readyErr } = await supabase.from("team_ready").delete().eq("room_id", room.id);
  if (readyErr) throw readyErr;

  const totalCells = room.board_size * room.board_size;
  // One statement for every fleet in the room rather than a loop over the team list, because the
  // host is allowed to write all of them ("fleets reset by host") and has no business knowing how
  // many there are or which is which.
  //
  // Deliberately NOT verified by rows returned, unlike the attack-log delete in resetRoomToLobby.
  // RLS applies to an UPDATE's RETURNING as well as to the write, and `fleets select own team` lets
  // the host read only their own - a host who is spectating holds no fleet at all and would read
  // back nothing from a write that had just succeeded for every crew. There is genuinely no way to
  // confirm this one from a browser, which is precisely why the same migration that ships the
  // re-seed also refuses the start of a battle over a fleet that isn't shaped for the board: a
  // silently rejected write here surfaces there as a sentence, instead of as an unhittable fleet.
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
    .eq("room_id", room.id);
  if (fleetErr) throw fleetErr;

  const { error: roomErr } = await supabase.from("rooms").update({ status: "placement" }).eq("id", room.id);
  if (roomErr) throw roomErr;
}

/**
 * Fleets that cannot be fought yet - unplaced, unconfirmed, or shaped for a different board.
 *
 * Asks the database, because no client may read another team's fleet row: that is the point of the
 * `fleets select own team` policy, and it is why a public `team_ready` mirror exists at all. See
 * supabase/migrations/20260819010000_no_fleet_no_battle.sql.
 *
 * Returns null - meaning "no verdict", not "all clear" - when the function isn't installed, so a
 * project on the previous schema still starts matches instead of being unable to play at all. The
 * trigger in that same migration is the enforcement; this is the part that can name the fleet.
 */
export async function unplacedFleets(roomId: string): Promise<number[] | null> {
  const { data, error } = await supabase.rpc("unplaced_fleets", { p_room_id: roomId });
  if (error) {
    if (error.code === "PGRST202" || /unplaced_fleets/.test(error.message)) return null;
    throw error;
  }
  return Array.isArray(data) ? (data as number[]) : [];
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
    }
  }

  // Readiness goes as a whole, in one delete, rather than as a per-team update inside the loop
  // above. The update WAS the loop's last line and it never worked on anyone but the host's own
  // team: `team_ready update own team` is scoped to the writer's team and there is no host update
  // policy, so RLS quietly matched zero rows and reported success for every other crew. Their
  // ready=true flags survived the reset, and a flag that outlives the match it belonged to is what
  // a later start reads as "this crew is placed". Deleting is allowed room-wide for the host
  // (`team_ready delete by host`), and a row that isn't there cannot be stale - every client
  // re-creates its own the moment it confirms.
  await supabase.from("team_ready").delete().eq("room_id", roomId);

  // A fresh seed for the next match, rolled in the same write as the status flip so there is no
  // moment where the lobby is open on the match everyone has just played. Both routes back to the
  // lobby come through here - "Play again" off the report, and the host's "End match" - and both
  // mean the next game, so both get a new world.
  //
  // The balanced layout is cleared in the same breath, and for the same reason the deep-water hides
  // are: it was dealt against fleets that are about to be wiped and re-placed, so carrying it into
  // the next match would balance the new board against ships nobody has any more. Clearing it is
  // also what lets balance-board run again - it refuses a room that already has one.
  //
  // The balance record goes with it, and that one is not housekeeping. balance-board writes the two
  // together, so they only disagree when the balancer does not run at all on the next match - and a
  // room that kept the old record through a failed re-balance would archive the match that WAS
  // played with the fairness of the match before it. A wrong number here is worse than none: it is
  // read on the recap, and every other match is ranked against it.
  //
  // Written even if the columns don't exist yet on an un-migrated project? No: that would fail the
  // whole reset. Retry without them instead, because getting everyone back to the lobby matters more
  // than the seed.
  const patch = {
    status: "lobby",
    winner_team: null,
    seed: generateSeed(),
    board_perm: null,
    balance_report: null,
  };
  const { error: roomErr } = await supabase.from("rooms").update(patch).eq("id", roomId);
  if (roomErr) {
    if (!/seed|board_perm|balance_report/i.test(roomErr.message)) throw roomErr;
    const { error: retryErr } = await supabase
      .from("rooms")
      .update({ status: "lobby", winner_team: null })
      .eq("id", roomId);
    if (retryErr) throw retryErr;
  }
}

/** A battle in progress, as the front page's "Current battles" list needs it. */
export interface LiveBattle {
  code: string;
  /** How many people are in the room at all - crews and spectators alike. */
  players: number;
  /** Fleets with at least one player on them, which is what "2 fleets" on the card means. */
  fleets: number;
  /** When the room was opened. Not when the match started - see fetchLiveBattles. */
  created_at: string;
}

/**
 * Every match currently being fought, for the front page.
 *
 * Deliberately `status = 'battle'` and nothing else. A lobby is somebody's room being arranged and
 * a placement phase is a match that hasn't opened yet - neither is a thing to walk in on, and
 * listing them would turn the front page into a directory of rooms to gatecrash. 'finished' is out
 * for the opposite reason: it's over, and the recap is already in "Recent battles" below.
 *
 * Two reads rather than a join, exactly as listRooms() does it for the admin: PostgREST can only
 * aggregate through a foreign-table select, and the counting is cheaper here than the round trip
 * saved. Rooms cap at 15 (see the room-limit migration) so both reads are small by construction.
 *
 * Every column read here is already world-readable ("rooms select" / "players select" are both
 * `using (true)`), so this publishes no fact a room code didn't already expose. What it does change
 * is that the codes themselves are now public - which is what the spectators_cannot_disrupt
 * migration exists to make safe.
 */
export async function fetchLiveBattles(): Promise<LiveBattle[]> {
  const { data: rooms, error } = await supabase
    .from("rooms")
    .select("id, code, created_at")
    .eq("status", "battle")
    .order("created_at", { ascending: false });
  if (error || !rooms || rooms.length === 0) return [];

  const ids = rooms.map((r) => r.id);
  const { data: players } = await supabase.from("players").select("room_id, team").in("room_id", ids);

  const heads = new Map<string, number>();
  const crews = new Map<string, Set<number>>();
  for (const p of players ?? []) {
    heads.set(p.room_id, (heads.get(p.room_id) ?? 0) + 1);
    if (p.team === null) continue;
    const teams = crews.get(p.room_id) ?? new Set<number>();
    teams.add(p.team);
    crews.set(p.room_id, teams);
  }

  return rooms.map((r) => ({
    code: r.code,
    players: heads.get(r.id) ?? 0,
    fleets: crews.get(r.id)?.size ?? 0,
    created_at: r.created_at,
  }));
}

/**
 * Is this room still there, and what is it doing?
 *
 * Null means gone - pruned after its idle hour, deleted by an admin, or never existed. Used by the
 * top bar to decide whether the way back to "your" room is worth offering, which it previously
 * assumed on the strength of a localStorage key that nothing ever refuted.
 *
 * Swallows read failures as `undefined`, which is deliberately NOT null: an offline browser or a
 * blocked read is not evidence that the room is gone, and treating it as such would pull the link
 * out from under someone whose match is fine and whose wifi isn't.
 */
export async function lookupRoom(code: string): Promise<{ code: string; status: string } | null | undefined> {
  const { data, error } = await supabase
    .from("rooms")
    .select("code, status")
    .eq("code", normalizeRoomCode(code))
    .maybeSingle();
  if (error) return undefined;
  return data ?? null;
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
