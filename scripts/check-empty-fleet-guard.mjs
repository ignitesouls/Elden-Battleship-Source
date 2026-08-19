/**
 * Proves a fleet with no ships on it cannot be dragged into a battle.
 *
 * This is the regression test for DEEPVOYAGE, where a crew played an hour and eleven minutes
 * against an opponent who was never on the board: forty-four shots at them, forty-four misses, no
 * hits, no possible elimination. Their fleet row held `placements = NULL` and was still shaped for
 * the 14x14 board the room had been before the host resized it to 10x10 - 196 grid cells and 13
 * hull counters against a 7-hull fleet - and the match started anyway, because what decides that is
 * `team_ready.ready`, a flag in a different table that survives every settings change.
 *
 * The fixture below rebuilds that row exactly, then asks the database to start the match.
 *
 * Written against the guard in supabase/migrations/20260819010000_no_fleet_no_battle.sql. It has to
 * be checked HERE rather than in a unit test, for the same reason the guard is in Postgres at all:
 * a player may read their own team's fleet and nobody else's, so no client can tell whether anyone
 * else has placed anything. The only participant that can see every fleet at once is the database,
 * and the only honest way to test what it will refuse is to ask it.
 *
 * Creates a throwaway room with two crews, exercises the guard, and cleans up after itself. Runs
 * entirely with the ANON key, exactly as two browsers would.
 *
 *   node scripts/check-empty-fleet-guard.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trimStart().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_ANON_KEY;

let fails = 0;

/** `detail` is printed only on failure, where it is a diagnosis rather than evidence. */
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${!pass && detail ? `\n      ${detail}` : ""}`);
  if (!pass) fails++;
};

const clients = [];

async function session(label) {
  const client = createClient(URL_, KEY, { auth: { persistSession: false } });
  clients.push(client);
  const { data, error } = await client.auth.signInAnonymously();
  if (error) {
    console.log(`FAIL  no anonymous session for ${label}: ${error.message}`);
    fails++;
    return null;
  }
  return { label, client, userId: data.user.id };
}

const grid = (n, v) => Array.from({ length: n }, () => v);

// A 10x10 Classic room: five hulls, a hundred cells.
const SHIP_DEFS = [
  { name: "Carrier", size: 5 },
  { name: "Battleship", size: 4 },
  { name: "Cruiser", size: 3 },
  { name: "Submarine", size: 3 },
  { name: "Destroyer", size: 2 },
];
/** One hull per even row, hard left. Legal, and nothing here cares where they are. */
const PLACEMENTS = [0, 2, 4, 6, 8].map((r, i) => ({ shipIndex: i, startRow: r, startCol: 0, isHorizontal: true }));

const host = await session("host");
const foe = await session("foe");
if (!host || !foe) process.exit(1);

const code = `GUARD${Math.floor(Math.random() * 100000)}`;
const { data: room, error: roomErr } = await host.client
  .from("rooms")
  .insert({ code, board_size: 10, ship_defs: SHIP_DEFS, status: "lobby" })
  .select()
  .single();
if (roomErr) {
  console.log(`FAIL  could not create the test room: ${roomErr.message}`);
  process.exit(1);
}

/** Whether the room is where we think it is, read back rather than assumed. */
async function status() {
  const { data } = await host.client.from("rooms").select("status").eq("id", room.id).single();
  return data?.status;
}

/** Every crew that still cannot be fought, as the database sees it. */
async function unplaced() {
  const { data, error } = await host.client.rpc("unplaced_fleets", { p_room_id: room.id });
  if (error) return { error: error.message };
  return { teams: data ?? [] };
}

try {
  await host.client.from("players").insert({ room_id: room.id, user_id: host.userId, nickname: "host", team: 0, is_host: true });
  await foe.client.from("players").insert({ room_id: room.id, user_id: foe.userId, nickname: "foe", team: 1, is_host: false });

  // Team 0 does everything right.
  await host.client.from("fleets").insert({
    room_id: room.id,
    team: 0,
    ship_grid: grid(100, false),
    ship_index_grid: grid(100, -1),
    ship_hits_remaining: SHIP_DEFS.map((s) => s.size),
    ship_sunk: grid(5, false),
    placements: PLACEMENTS,
    placement_confirmed: true,
  });

  // Team 1 is the DEEPVOYAGE row: never placed, and still carrying the shape of a 14x14 Armada
  // board that this room stopped being before anybody fired a shot.
  await foe.client.from("fleets").insert({
    room_id: room.id,
    team: 1,
    ship_grid: grid(196, false),
    ship_index_grid: grid(196, -1),
    ship_hits_remaining: [5, 4, 3, 3, 2, 5, 4, 3, 3, 2, 5, 4, 3],
    ship_sunk: grid(13, false),
    placements: null,
    placement_confirmed: false,
  });

  await host.client.from("rooms").update({ status: "placement" }).eq("id", room.id);

  const empty = await unplaced();
  check(
    "unplaced_fleets names the crew with no ships, and only that crew",
    JSON.stringify(empty.teams) === "[1]",
    empty.error
      ? `the function is not installed: ${empty.error}`
      : `expected [1], got ${JSON.stringify(empty.teams)} - team 0 is fully placed and must not be listed`
  );

  const { error: blocked } = await host.client.from("rooms").update({ status: "battle" }).eq("id", room.id);
  check(
    "a battle cannot start over a fleet that was never placed",
    Boolean(blocked) && (await status()) === "placement",
    blocked
      ? `the write was refused but the room moved anyway - status is now ${await status()}`
      : "no error and the room entered battle: an unhittable fleet just took the field"
  );

  // Now placed - but the row is still shaped for the old board, so the hulls hang off the edge of
  // this one and the hit counters belong to a fleet twice this size.
  await foe.client.from("fleets").update({ placements: PLACEMENTS, placement_confirmed: true }).eq("room_id", room.id).eq("team", 1);
  const stillWrong = await unplaced();
  const { error: blocked2 } = await host.client.from("rooms").update({ status: "battle" }).eq("id", room.id);
  check(
    "a battle cannot start over a fleet shaped for a different board",
    Boolean(blocked2) && (await status()) === "placement" && JSON.stringify(stillWrong.teams) === "[1]",
    `unplaced_fleets returned ${JSON.stringify(stillWrong.teams)}; a confirmed layout on a 196-cell row is still not a fleet for a 100-cell board`
  );

  // Re-seeded to this board the way beginPlacementPhase now does it for every crew at once.
  await foe.client
    .from("fleets")
    .update({
      ship_grid: grid(100, false),
      ship_index_grid: grid(100, -1),
      ship_hits_remaining: SHIP_DEFS.map((s) => s.size),
      ship_sunk: grid(5, false),
    })
    .eq("room_id", room.id)
    .eq("team", 1);

  const clean = await unplaced();
  const { error: allowed } = await host.client.from("rooms").update({ status: "battle" }).eq("id", room.id);
  check(
    "a battle starts normally once both fleets are real",
    !allowed && (await status()) === "battle" && JSON.stringify(clean.teams) === "[]",
    allowed
      ? `refused a legitimate start: ${allowed.message}`
      : `unplaced_fleets returned ${JSON.stringify(clean.teams)} and the room is ${await status()}`
  );

  // The guard is one transition, not a lock on the row. Everything else about a room with an
  // unplaced crew in it must still be writable - renaming fleets, rolling the seed, ending it.
  await host.client.from("rooms").update({ status: "placement" }).eq("id", room.id);
  await foe.client.from("fleets").update({ placements: null, placement_confirmed: false }).eq("room_id", room.id).eq("team", 1);
  const { error: rename } = await host.client.from("rooms").update({ team_names: ["renamed", null] }).eq("id", room.id);
  check("every other write to the room is untouched by the guard", !rename, rename?.message ?? "");
} finally {
  /**
   * Cleaning up is itself a thing that can silently not happen.
   *
   * `rooms delete by admin` is the only delete policy on the table, so the delete below is a no-op
   * for an ordinary anonymous session - no error, no rows, and a test room left standing. That is
   * how three of these accumulated the first time this ran. Deleting is still tried, because
   * whoever runs this from an admin account gets a clean removal; when it doesn't take, both player
   * rows go instead (`players delete own` needs no privileges), which leaves an empty room for
   * prune_stale_rooms() to collect within the hour. The room never reaches 'battle' on the way out
   * either, so it cannot appear in the front page's live list in the meantime.
   */
  await host.client.from("rooms").delete().eq("id", room.id);
  const { data: left } = await host.client.from("rooms").select("id").eq("id", room.id);
  if ((left ?? []).length > 0) {
    await host.client.from("players").delete().eq("room_id", room.id).eq("user_id", host.userId);
    await foe.client.from("players").delete().eq("room_id", room.id).eq("user_id", foe.userId);
    console.log(`\nnote: ${code} could not be deleted (admins only) - emptied it instead, and stale rooms are pruned after an hour.`);
  }
}

console.log(
  fails === 0
    ? "\nALL PASS - a fleet that isn't there cannot be fought."
    : `\n${fails} FAILED - a crew that cannot be hit cannot lose, and their opponents cannot win.`
);

for (const c of clients) {
  try {
    await c.auth.signOut();
    await c.removeAllChannels();
  } catch {
    // Best effort; we are on our way out.
  }
}

process.exit(fails === 0 ? 0 : 1);
