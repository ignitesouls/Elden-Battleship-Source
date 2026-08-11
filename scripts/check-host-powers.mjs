/**
 * Proves the host's buttons actually DO something.
 *
 * Every one of these is a write that RLS can silently turn into a no-op: Postgres makes an UPDATE
 * or DELETE with no matching policy affect zero rows and report NO error, so a fully blocked host
 * action is indistinguishable from a successful one in the browser. That is not a hypothetical
 * here - it is exactly how the kick button was broken before "players delete by host" was added
 * (see RUN_THESE.sql section 1), and the reason each check below re-READS the row rather than
 * trusting the absence of an error.
 *
 * Creates a throwaway room with a host, a crewmate and an opponent, exercises each host power, and
 * cleans up after itself. Runs entirely with the ANON key, exactly as a browser does.
 *
 *   node scripts/check-host-powers.mjs
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

/**
 * `detail` is printed only on FAILURE.
 *
 * Every detail string in this file is a diagnosis of what went wrong - "RLS turned the update into
 * a no-op", "needs an attacks delete by host policy" - which printed under a PASS reads as though
 * the check passed AND the thing is broken. The sibling check-square-counts.mjs prints its details
 * always, and correctly: there they are neutral evidence (the rows that came back) rather than an
 * explanation of a failure that didn't happen.
 */
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${!pass && detail ? `\n      ${detail}` : ""}`);
  if (!pass) fails++;
};

const clients = [];
function newClient() {
  const c = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  clients.push(c);
  return c;
}

async function person(label) {
  const client = newClient();
  const { data, error } = await client.auth.signInAnonymously();
  if (error) {
    console.log(`FAIL  no anonymous session for ${label}: ${error.message}`);
    fails++;
    return null;
  }
  return { label, client, userId: data.user.id };
}

async function main() {
  const host = await person("host");
  const mate = await person("crewmate");
  const foe = await person("opponent");
  if (!host || !mate || !foe) return;

  const code = `HOSTTEST${Math.floor(Math.random() * 1e5)}`;
  const { data: room, error: roomErr } = await host.client
    .from("rooms")
    .insert({ code, board_size: 10, status: "battle" })
    .select()
    .single();
  if (roomErr) {
    console.log("FAIL  could not create a test room: " + roomErr.message);
    fails++;
    return;
  }

  async function join(p, team, isHost = false) {
    const { data, error } = await p.client
      .from("players")
      .insert({ room_id: room.id, user_id: p.userId, nickname: p.label, team, is_host: isHost })
      .select()
      .single();
    if (error) {
      console.log(`FAIL  ${p.label} could not join: ${error.message}`);
      fails++;
      return null;
    }
    return data;
  }

  const hostRow = await join(host, 0, true);
  const mateRow = await join(mate, 0);
  const foeRow = await join(foe, 1);
  if (!hostRow || !mateRow || !foeRow) return;

  /** Reads a player row back with a client that is allowed to see it (players select is public). */
  const readPlayer = async (id) => {
    const { data } = await host.client.from("players").select().eq("id", id).maybeSingle();
    return data;
  };

  // -- 1. Renaming somebody else -----------------------------------------------
  const { error: renameErr } = await host.client
    .from("players")
    .update({ nickname: "RENAMED BY HOST" })
    .eq("id", mateRow.id);
  const afterRename = await readPlayer(mateRow.id);
  check(
    "the host can RENAME another player",
    afterRename?.nickname === "RENAMED BY HOST",
    renameErr
      ? `error: ${renameErr.message}`
      : `no error reported, but the nickname is still "${afterRename?.nickname}" - RLS turned the update into a no-op. Needs a "players update by host" policy.`
  );

  // -- 2. Kicking somebody -----------------------------------------------------
  const { error: kickErr } = await host.client.from("players").delete().eq("id", foeRow.id);
  const afterKick = await readPlayer(foeRow.id);
  check(
    "the host can KICK another player",
    afterKick === null,
    kickErr
      ? `error: ${kickErr.message}`
      : "no error reported, but the row is still there - RLS turned the delete into a no-op."
  );

  // -- 3. A non-host must NOT be able to do either ------------------------------
  await mate.client.from("players").update({ nickname: "HIJACKED" }).eq("id", hostRow.id);
  const hostAfter = await readPlayer(hostRow.id);
  check(
    "a non-host CANNOT rename the host",
    hostAfter?.nickname === "host",
    `nickname is now "${hostAfter?.nickname}"`
  );

  // -- 4. Ending the match / Play again ----------------------------------------
  //
  // resetRoomToLobby's real work, in the same order the client does it: bin the attack log, wipe
  // the tallies, reset every fleet and ready flag, then flip the room back to the lobby.
  await host.client.from("attacks").insert({
    room_id: room.id,
    cell_index: 5,
    attacker_team: 0,
    defender_team: 1,
    result: "miss",
  });

  const { data: deletedAttacks } = await host.client
    .from("attacks")
    .delete()
    .eq("room_id", room.id)
    .select("id");
  check(
    "the host can CLEAR THE ATTACK LOG (End match / Play again)",
    (deletedAttacks ?? []).length > 0,
    (deletedAttacks ?? []).length > 0 ? "" : "the delete removed zero rows - needs an \"attacks delete by host\" policy"
  );

  // The crewmate's fleet, which the host has to be able to reset on everyone's behalf.
  await mate.client.from("fleets").insert({ room_id: room.id, team: 0, placement_confirmed: true });
  const { data: resetFleets } = await host.client
    .from("fleets")
    .update({ placement_confirmed: false, placements: null })
    .eq("room_id", room.id)
    .eq("team", 0)
    .select("team");
  check(
    "the host can RESET ANOTHER TEAM'S fleet",
    (resetFleets ?? []).length > 0,
    (resetFleets ?? []).length > 0
      ? ""
      : "zero rows updated. Not fatal - each client self-heals when it sees status 'lobby' - but the host's own reset does nothing here."
  );

  const { data: flipped } = await host.client
    .from("rooms")
    .update({ status: "lobby", winner_team: null })
    .eq("id", room.id)
    .select("status");
  check(
    "the host can send the room BACK TO THE LOBBY",
    flipped?.[0]?.status === "lobby",
    flipped?.[0]?.status ? "" : "zero rows updated - the room stays in 'battle' and nobody can leave the match"
  );

  // -- 5. Becoming host when the current one goes dark -------------------------
  const { error: claimErr } = await mate.client.rpc("claim_room_host", { p_player_id: mateRow.id });
  const mateAfter = await readPlayer(mateRow.id);
  const hostAfterClaim = await readPlayer(hostRow.id);
  check(
    "a crewmate can BECOME HOST via claim_room_host",
    mateAfter?.is_host === true,
    claimErr ? `error: ${claimErr.message}` : `is_host is ${mateAfter?.is_host}`
  );
  check(
    "...and the old host stops being host (exactly one host)",
    hostAfterClaim?.is_host === false,
    `old host is_host is ${hostAfterClaim?.is_host}`
  );

  // -- Clean up ---------------------------------------------------------------
  await host.client.from("rooms").delete().eq("id", room.id);
}

await main();

console.log(
  fails === 0
    ? "\nALL PASS - every host power actually takes effect."
    : `\n${fails} FAILED - a host button that reports success and does nothing is the worst kind.`
);

for (const c of clients) {
  try {
    await c.auth.signOut();
    await c.removeAllChannels();
  } catch {
    // Best effort; we are on our way out.
  }
}
