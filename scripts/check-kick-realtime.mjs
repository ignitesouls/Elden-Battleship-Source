/**
 * Does a kicked player actually disappear in real time?
 *
 * useRoom subscribes to `players` with `filter: room_id=eq.<room>` and has a correct DELETE branch
 * that drops the row and clears myPlayer. Whether that branch ever RUNS is a different question:
 * on DELETE, Postgres replicates only the columns in the table's REPLICA IDENTITY, which defaults
 * to the primary key. So `old` carries `id` and nothing else - there is no `room_id` on the record
 * for the filter to match, and Realtime drops the message before it reaches anyone.
 *
 * That is the same wall documented in useSquareCounts, where a tally of 0 is WRITTEN rather than
 * the row being deleted, precisely so the change survives the filter.
 *
 * This checks both shapes so the answer is unambiguous:
 *   - filtered by room_id, which is what the app actually subscribes with
 *   - unfiltered, to separate "the filter dropped it" from "deletes aren't delivered at all"
 *
 *   node scripts/check-kick-realtime.mjs
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

let fails = 0;
/** `detail` prints only on failure - every one here is a diagnosis, not evidence. */
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${!pass && detail ? `\n      ${detail}` : ""}`);
  if (!pass) fails++;
};

const clients = [];
const client = () => {
  const c = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  clients.push(c);
  return c;
};

async function person(label) {
  const c = client();
  const { data, error } = await c.auth.signInAnonymously();
  if (error) throw new Error(`no session for ${label}: ${error.message}`);
  return { label, client: c, userId: data.user.id };
}

const subscribed = (channel) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for SUBSCRIBED")), 10000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(t);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(t);
        reject(new Error(status));
      }
    });
  });

const host = await person("host");
const victim = await person("victim");

const code = `KICKTEST${Math.floor(Math.random() * 1e5)}`;
const { data: room } = await host.client
  .from("rooms")
  .insert({ code, board_size: 10, status: "lobby" })
  .select()
  .single();

const join = async (p, team, isHost = false) => {
  const { data } = await p.client
    .from("players")
    .insert({ room_id: room.id, user_id: p.userId, nickname: p.label, team, is_host: isHost })
    .select()
    .single();
  return data;
};

await join(host, 0, true);
const victimRow = await join(victim, 1);

// What the app actually does.
const filtered = [];
const filteredChannel = victim.client
  .channel(`kick-filtered-${room.id}`)
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "players", filter: `room_id=eq.${room.id}` },
    (payload) => filtered.push(payload.eventType)
  );

// The control: same table, no filter.
const unfiltered = [];
const unfilteredChannel = victim.client
  .channel(`kick-unfiltered-${room.id}`)
  .on("postgres_changes", { event: "*", schema: "public", table: "players" }, (payload) =>
    unfiltered.push(payload.eventType)
  );

await subscribed(filteredChannel);
await subscribed(unfilteredChannel);

// An UPDATE first, to prove the filtered channel is alive and delivering at all. Without this a
// silent DELETE is indistinguishable from a channel that was never working.
await host.client.from("players").update({ nickname: "still here" }).eq("id", victimRow.id);
await new Promise((r) => setTimeout(r, 3000));

check(
  "the filtered channel delivers an UPDATE (control)",
  filtered.includes("UPDATE"),
  filtered.includes("UPDATE") ? "" : `got ${JSON.stringify(filtered)} - the channel itself isn't working`
);

// The kick.
await host.client.from("players").delete().eq("id", victimRow.id);
await new Promise((r) => setTimeout(r, 4000));

check(
  "a kicked player receives the DELETE on the app's filtered channel",
  filtered.includes("DELETE"),
  "no DELETE arrived. `players` replicates only its primary key on delete, so `room_id` isn't on " +
    "the record and the filter drops the message. Fix: alter table public.players replica identity full;"
);

check(
  "...and on an unfiltered channel",
  unfiltered.includes("DELETE"),
  "not delivered even unfiltered - RLS cannot be evaluated against a record that is only an id"
);

console.log(
  fails === 0
    ? "\nALL PASS - kicks propagate live."
    : `\n${fails} FAILED - a kicked player sits in a dead room until they reload.`
);

await host.client.from("rooms").delete().eq("id", room.id);
for (const c of clients) {
  try {
    await c.removeAllChannels();
    await c.auth.signOut();
  } catch {
    // On our way out.
  }
}
process.exit(fails === 0 ? 0 : 1);
