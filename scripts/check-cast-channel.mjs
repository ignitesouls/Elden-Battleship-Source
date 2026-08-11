/**
 * Proves the caster's control page can actually drive an OBS browser source.
 *
 * The whole board-overlay design rests on one assumption: that a Realtime BROADCAST channel works
 * between two clients holding nothing but the anon key. If this project ever has Realtime
 * Authorization (private channels) turned on, sends are dropped silently - no error, no message -
 * and the symptom is a board that just never updates on stream, in front of an audience. That is
 * worth a script rather than a hope.
 *
 * Simulates the real pair: a "source" that subscribes and says hello, and a "controller" that
 * answers the hello and then pushes a frame. Both anonymous, exactly as the browser is.
 *
 *   node scripts/check-cast-channel.mjs
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
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${!pass && detail ? `\n      ${detail}` : ""}`);
  if (!pass) fails++;
};

const client = () =>
  createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

// Must match lib/overlayCast.ts.
const CHANNEL = `cast:CASTCHECK${Math.floor(Math.random() * 1e5)}`;
const STATE_EVENT = "cast-state";
const HELLO_EVENT = "cast-hello";

const controller = client();
const source = client();

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

const received = [];
let helloSeen = false;

const controlChannel = controller
  .channel(CHANNEL, { config: { broadcast: { self: false } } })
  .on("broadcast", { event: HELLO_EVENT }, () => {
    helloSeen = true;
    // Exactly what useCastPublisher does: answer a new source at once.
    void controlChannel.send({
      type: "broadcast",
      event: STATE_EVENT,
      payload: { view: { mode: "all", zoom: 2.5, cx: 0.25, cy: 0.75 }, fleets: [{ team: 0 }], at: Date.now() },
    });
  });

const sourceChannel = source
  .channel(CHANNEL, { config: { broadcast: { self: false } } })
  .on("broadcast", { event: STATE_EVENT }, ({ payload }) => received.push(payload));

try {
  await subscribed(controlChannel);
  await subscribed(sourceChannel);
  check("both ends can subscribe to a broadcast channel with the anon key", true);

  // The source announcing itself, as it does on every (re)subscribe.
  await sourceChannel.send({ type: "broadcast", event: HELLO_EVENT, payload: {} });
  await new Promise((r) => setTimeout(r, 3000));

  check("the controller receives a source's hello", helloSeen, "no hello arrived - sends are being dropped");
  check(
    "the source receives the frame sent back",
    received.length > 0,
    "the controller answered but nothing arrived - a board source would sit blank on stream"
  );

  if (received.length > 0) {
    const frame = received[0];
    check(
      "the frame survives the round trip intact",
      frame?.view?.mode === "all" && frame?.view?.zoom === 2.5 && frame?.fleets?.length === 1,
      `got ${JSON.stringify(frame)}`
    );
  }
} catch (e) {
  check("broadcast channel is usable", false, e instanceof Error ? e.message : String(e));
}

console.log(
  fails === 0
    ? "\nALL PASS - a caster's control page can drive a credential-free browser source."
    : `\n${fails} FAILED - the board overlay cannot be driven in this state.`
);

for (const c of [controller, source]) {
  try {
    await c.removeAllChannels();
  } catch {
    // On our way out.
  }
}
process.exit(fails === 0 ? 0 : 1);
