/**
 * Proves that shared square counts are readable by your own fleet and by spectators, and by nobody
 * else.
 *
 * The counts are a team's working-out - "we've done 2 of the 3 tunnels" - so an opponent who could
 * read them would learn both what you are chasing and how far along you are. That protection is
 * entirely the "square_counts select own team" RLS policy; nothing in the client enforces it, and
 * nothing in the client CAN. This is how you check the policy is actually on.
 *
 * The spectator is the deliberate exception ("square_counts select by spectator"): a caster has to
 * see every fleet's tallies, and that is checked here too, because a policy that quietly failed to
 * apply would look exactly like a match where nobody happened to be counting.
 *
 * Creates a throwaway room, puts four anonymous accounts in it (two crewmates on team 0, one
 * opponent on team 1, one spectator on no team), writes a count, and then reads it back as each of
 * them. Cleans up after itself. Runs entirely with the ANON key, exactly as a browser does.
 *
 *   node scripts/check-square-counts.mjs
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
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
  if (!pass) fails++;
};

/**
 * Every client made here, so they can all be disconnected at the end.
 *
 * Not housekeeping: a Supabase client holds an open realtime socket and its retry timers, and
 * exiting the process on top of one trips a libuv assertion on Windows that prints a stack trace
 * directly under the result - making a check that worked perfectly look like it crashed.
 */
const clients = [];
function newClient() {
  const c = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  clients.push(c);
  return c;
}

/** A fresh anonymous session, i.e. one distinct person as far as auth.uid() is concerned. */
async function person(label) {
  const client = newClient();
  const { data, error } = await client.auth.signInAnonymously();
  if (error) {
    console.log(`FAIL  could not create an anonymous session for ${label}: ${error.message}`);
    console.log("      Enable anonymous sign-ins in Supabase -> Authentication -> Providers, or run");
    console.log("      this check by hand with two real logins.");
    fails++;
    return null;
  }
  return { label, client, userId: data.user.id };
}

/**
 * Everything after the setup, in a function purely so a failure can `return`.
 *
 * process.exit() while a Supabase client still holds a websocket trips a libuv assertion on
 * Windows, which prints a stack trace directly underneath the failure the reader is supposed to be
 * looking at - and makes a working check look like a broken one.
 */
async function main() {
  // -- Does the table even exist? ---------------------------------------------
  const probe = newClient();
  const { error: probeErr } = await probe.from("square_counts").select("room_id").limit(1);
  if (probeErr) {
    console.log("FAIL  `square_counts` is not readable at all:");
    console.log("      " + probeErr.message);
    console.log("\n      The site falls back to browser-only counts in this state - it works, but");
    console.log("      teammates can't see each other's and a spectator sees none at all.");
    console.log("      Apply STEP 1 of RUN_THESE.sql, on its own, then re-run this.");
    fails++;
    return;
  }

  const mate = await person("crewmate");
  const me = await person("me");
  const foe = await person("opponent");
  const caster = await person("spectator");
  if (!mate || !me || !foe || !caster) return;

  // -- Build a room with two fleets in it ---------------------------------------
  const code = `TEST${Math.floor(Math.random() * 1e6)}`;
  const { data: room, error: roomErr } = await me.client
    .from("rooms")
    .insert({ code, board_size: 10, ship_defs: [], status: "battle" })
    .select()
    .single();
  if (roomErr) {
    console.log("FAIL  could not create a test room: " + roomErr.message);
    fails++;
    return;
  }

  let joinFailed = false;
  async function join(p, team) {
    const { data, error } = await p.client
      .from("players")
      .insert({ room_id: room.id, user_id: p.userId, nickname: p.label, team })
      .select()
      .single();
    if (error) {
      console.log(`FAIL  ${p.label} could not join: ${error.message}`);
      fails++;
      joinFailed = true;
      return null;
    }
    return data;
  }

  const mePlayer = await join(me, 0);
  await join(mate, 0);
  await join(foe, 1);
  // team null IS what a spectator is, here and in the policy - see "square_counts select by
  // spectator". Nothing else distinguishes one.
  await join(caster, null);
  if (joinFailed) return;

  // -- Write a count as "me", on team 0 -----------------------------------------
  const { error: writeErr } = await me.client.from("square_counts").upsert(
    { room_id: room.id, player_id: mePlayer.id, team: 0, cell_index: 42, tally: 7 },
    { onConflict: "room_id,player_id,cell_index" }
  );
  check("a player can write their own count", !writeErr, writeErr?.message ?? "");

  const read = async (p) => {
    const { data } = await p.client.from("square_counts").select("cell_index, tally").eq("room_id", room.id);
    return data ?? [];
  };

  // -- The three questions that matter ------------------------------------------
  const mine = await read(me);
  check("I can read my own count", mine.length === 1 && mine[0].tally === 7, JSON.stringify(mine));

  const crew = await read(mate);
  check("my CREWMATE can read it", crew.length === 1 && crew[0].tally === 7, JSON.stringify(crew));

  const enemy = await read(foe);
  check(
    "the OTHER TEAM cannot read it",
    enemy.length === 0,
    enemy.length === 0 ? "" : `LEAKED ${enemy.length} row(s): ${JSON.stringify(enemy)}`
  );

  // The spectator is the one reader who is meant to see EVERY fleet's counts - that is the whole
  // point of the policy, and the difference between a caster who can follow a match and one who
  // can only see where the shots landed.
  const watcher = await read(caster);
  check(
    "a SPECTATOR can read it",
    watcher.length === 1 && watcher[0].tally === 7,
    watcher.length === 0
      ? "got nothing - is the \"square_counts select by spectator\" policy applied?"
      : JSON.stringify(watcher)
  );

  // -- And that they can't forge one onto our fleet either ----------------------
  const { error: forgeErr } = await foe.client
    .from("square_counts")
    .insert({ room_id: room.id, player_id: mePlayer.id, team: 0, cell_index: 9, tally: 99 });
  check("the other team cannot forge a count onto our fleet", Boolean(forgeErr), forgeErr ? "" : "the insert was ACCEPTED");

  // -- Realtime is a SEPARATE read path, and needs its own proof ----------------
  //
  // The REST checks above say nothing about the websocket: postgres_changes is meant to apply the
  // same policy per subscriber, but "meant to" is not evidence, and a leak here would be completely
  // invisible from the UI - the opponent's client would simply receive rows it chose not to draw.
  // So: subscribe as each side, write a count, and see who is actually sent it.
  async function watch(p) {
    const seen = [];
    const channel = p.client
      .channel(`sc-probe-${p.label}-${Date.now()}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "square_counts", filter: `room_id=eq.${room.id}` },
        (payload) => seen.push(payload.new)
      );
    await new Promise((resolve) => channel.subscribe((status) => status === "SUBSCRIBED" && resolve()));
    return { seen, channel, client: p.client };
  }

  const foeWatch = await watch(foe);
  const crewWatch = await watch(mate);
  // The spectator's live feed is a SEPARATE grant from the REST read above - postgres_changes
  // evaluates its own policy per subscriber - and it is the half that makes a caster's boards
  // update during a match rather than on refresh. See useSpectatorCounts.
  const casterWatch = await watch(caster);

  await me.client.from("square_counts").upsert(
    { room_id: room.id, player_id: mePlayer.id, team: 0, cell_index: 55, tally: 3 },
    { onConflict: "room_id,player_id,cell_index" }
  );
  await new Promise((r) => setTimeout(r, 4000)); // generous: this is a network round trip, not a tick

  check("realtime DELIVERS the change to my crewmate", crewWatch.seen.length > 0, `received ${crewWatch.seen.length}`);
  check(
    "realtime DELIVERS the change to a spectator",
    casterWatch.seen.length > 0,
    casterWatch.seen.length > 0 ? "" : "received nothing - a caster's boards would only update on refresh"
  );
  check(
    "realtime does NOT deliver it to the other team",
    foeWatch.seen.length === 0,
    foeWatch.seen.length === 0 ? "" : `LEAKED over the websocket: ${JSON.stringify(foeWatch.seen)}`
  );

  await foeWatch.client.removeChannel(foeWatch.channel);
  await crewWatch.client.removeChannel(crewWatch.channel);
  await casterWatch.client.removeChannel(casterWatch.channel);

  // -- Clean up ---------------------------------------------------------------
  await me.client.from("square_counts").delete().eq("room_id", room.id);
  await me.client.from("rooms").delete().eq("id", room.id);
}

await main();

console.log(
  fails === 0
    ? "\nALL PASS - counts reach your fleet and spectators, live, and reach nobody else."
    : `\n${fails} FAILED - do not ship shared counts in this state.`
);

// Close the sockets before leaving, so the exit is quiet - see `clients` above.
for (const c of clients) {
  try {
    await c.removeAllChannels();
    c.realtime.disconnect();
  } catch {
    // Nothing left to close. Not a result.
  }
}
process.exitCode = fails ? 1 : 0;
