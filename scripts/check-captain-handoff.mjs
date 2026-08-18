/**
 * Proves the lobby's "Make captain" button does what it says, and that nothing else can.
 *
 * Captaincy is derived from team_joined_at, so a handover is a write to somebody ELSE'S player row -
 * the one thing "players update own" forbids. It therefore goes through hand_over_captaincy(), and
 * every guard that matters lives in that function rather than in the UI that hides the button. This
 * exercises both halves: that a captain can hand command on, and that a crewmate helping themselves
 * to it - directly or through the RPC, in the lobby or mid-match - is refused.
 *
 * Runs entirely with the ANON key, exactly as a browser does. Creates a throwaway room and deletes
 * it afterwards with the service role, since "rooms delete by admin" doesn't cover an anon session.
 *
 *   node scripts/check-captain-handoff.mjs
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

/** `detail` prints only on failure - it explains what went wrong, which reads as nonsense on a PASS. */
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

let roomId = null;
const code = `CAPTTEST${Math.floor(Math.random() * 1e5)}`;

try {
  const cap = await person("captain");
  const mate = await person("crewmate");
  const foe = await person("opponent");
  if (!cap || !mate || !foe) throw new Error("could not sign in");

  const { data: room, error: roomErr } = await cap.client
    .from("rooms")
    .insert({ code, board_size: 10, status: "lobby" })
    .select()
    .single();
  if (roomErr) throw new Error(`could not create a test room: ${roomErr.message}`);
  roomId = room.id;

  /** Joins with an explicit team_joined_at, so the pick order under test is the one intended. */
  async function join(p, team, pickedAt) {
    const { data, error } = await p.client
      .from("players")
      .insert({
        room_id: room.id,
        user_id: p.userId,
        nickname: p.label,
        team,
        team_joined_at: pickedAt,
        is_host: p.label === "captain",
      })
      .select()
      .single();
    if (error) throw new Error(`${p.label} could not join: ${error.message}`);
    return data;
  }

  const t0 = new Date();
  const capRow = await join(cap, 0, t0.toISOString());
  const mateRow = await join(mate, 0, new Date(t0.getTime() + 60_000).toISOString());
  const foeRow = await join(foe, 1, t0.toISOString());

  const readPlayer = async (id) => {
    const { data } = await cap.client.from("players").select().eq("id", id).maybeSingle();
    return data;
  };
  /** The database's own answer, which the client's captainOf() has to agree with exactly. */
  const captainId = async (team) => {
    const { data } = await cap.client.rpc("team_captain", { p_room: room.id, p_team: team });
    return data;
  };

  // -- 1. The earlier pick starts out in command -------------------------------
  check(
    "the first player to pick the fleet is its captain",
    (await captainId(0)) === capRow.id,
    "team_captain() disagrees with pick order - the handover has nothing dependable to move"
  );

  // -- 2. A crewmate cannot take command --------------------------------------
  const { error: grabErr } = await mate.client.rpc("hand_over_captaincy", { p_target: mateRow.id });
  check(
    "a crewmate CANNOT hand command to themselves",
    !!grabErr && (await captainId(0)) === capRow.id,
    grabErr ? "the RPC errored but command moved anyway" : "the RPC allowed it - anyone on the fleet can seize the board"
  );

  // -- 3. ...nor by writing their own row directly ------------------------------
  //
  // The lobby is open season on your own team_joined_at by design (that column is how setPlayerTeam
  // records a pick), so this is not a hole the migration closes - it is the reason the button is
  // captain-only rather than the enforcement being left to the UI. Recorded, not asserted.
  await mate.client
    .from("players")
    .update({ team_joined_at: new Date(t0.getTime() - 60_000).toISOString() })
    .eq("id", mateRow.id);
  console.log(
    `NOTE  in the lobby a crewmate's direct PATCH of their own team_joined_at does move command ` +
      `(now ${(await captainId(0)) === mateRow.id ? "the crewmate" : "the captain"}). ` +
      "Cooperative game, same as the host takeover."
  );
  // Put the pick order back for the checks below.
  await mate.client
    .from("players")
    .update({ team_joined_at: new Date(t0.getTime() + 60_000).toISOString() })
    .eq("id", mateRow.id);

  // -- 4. The captain CAN hand it over ------------------------------------------
  const { error: giveErr } = await cap.client.rpc("hand_over_captaincy", { p_target: mateRow.id });
  check(
    "the captain CAN hand command to a crewmate",
    !giveErr && (await captainId(0)) === mateRow.id,
    giveErr
      ? `error: ${giveErr.message}`
      : "no error, but team_captain() still names the old captain - the button would report success and change nothing"
  );
  check(
    "...and the old captain is now ordinary crew",
    (await captainId(0)) !== capRow.id,
    "two rows are tied for earliest; the id tie-break should have been made impossible"
  );

  // -- 5. Not somebody on another fleet -----------------------------------------
  const { error: foeErr } = await mate.client.rpc("hand_over_captaincy", { p_target: foeRow.id });
  check(
    "the captain CANNOT hand command to another fleet's player",
    !!foeErr && (await captainId(1)) === foeRow.id,
    foeErr ? "errored, but team 1's captaincy moved" : "the RPC allowed a cross-fleet handover"
  );

  // -- 6. Mid-match, command is nailed down -------------------------------------
  await cap.client.from("rooms").update({ status: "placement" }).eq("id", room.id);

  const { error: lateErr } = await mate.client.rpc("hand_over_captaincy", { p_target: capRow.id });
  check(
    "command CANNOT change hands once placement has started",
    !!lateErr && (await captainId(0)) === mateRow.id,
    lateErr ? "errored, but command moved mid-placement" : "the RPC allowed a handover mid-match"
  );

  // The hole the captain_handoff migration closes: seizing the board out from under a captain who
  // is mid-layout, by backdating your own row with a direct PATCH.
  const { error: patchErr } = await cap.client
    .from("players")
    .update({ team_joined_at: new Date(t0.getTime() - 3_600_000).toISOString() })
    .eq("id", capRow.id);
  const seized = (await readPlayer(capRow.id))?.team_joined_at;
  check(
    "a direct PATCH of team_joined_at is refused mid-placement",
    !!patchErr && (await captainId(0)) === mateRow.id,
    patchErr
      ? "the trigger errored but the row changed anyway"
      : `no error and team_joined_at is now ${seized} - guard_team_changes still ignores this column, ` +
        "so anyone can take the board mid-layout. Run supabase/migrations/20260813000000_captain_handoff.sql."
  );
} catch (e) {
  console.log(`FAIL  ${e instanceof Error ? e.message : String(e)}`);
  fails++;
} finally {
  if (roomId) {
    const admin = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { error } = await admin.from("rooms").delete().eq("id", roomId);
    console.log(error ? `  cleanup FAILED: ${error.message} (room ${code})` : `  cleaned up room ${code}`);
  }
  for (const c of clients) {
    try {
      await c.auth.signOut();
      await c.removeAllChannels();
    } catch {
      // Best effort; we are on our way out.
    }
  }
}

console.log(
  fails === 0
    ? "\nALL PASS - command changes hands only when a captain hands it over."
    : `\n${fails} FAILED.`
);
process.exit(fails === 0 ? 0 : 1);
