/**
 * Checks that the shared match clock is actually working against the live database.
 *
 * The match timer counts from a Postgres timestamp (the start marker in `attacks`), so it has to
 * subtract that from the SERVER's clock, not the browser's. serverTime.ts measures the offset by
 * calling server_now() - and deliberately falls back to the raw local clock if that call fails, so
 * a missing function looks exactly like everything being fine. This is how you tell the difference.
 *
 * Runs with the ANON key on purpose: the grant is half the fix, and a function that exists but
 * isn't executable by anon would leave every real player on the broken path.
 *
 *   node scripts/check-server-clock.mjs
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

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

const sentAt = Date.now();
const { data, error } = await supabase.rpc("server_now");
const receivedAt = Date.now();

if (error) {
  console.log("FAIL  server_now() is not callable by anon.");
  console.log("      " + error.message);
  console.log("\n      The clock silently falls back to each player's own PC clock, which is the");
  console.log("      bug it was meant to fix. Apply item 0 of RUN_THESE.sql.");
  process.exit(1);
}

// Same midpoint estimate the client uses, so this reports the offset the app would actually apply.
const rtt = receivedAt - sentAt;
const offset = new Date(data).getTime() - (sentAt + rtt / 2);

console.log("OK    server_now() exists and anon can execute it.");
console.log(`      server time : ${data}`);
console.log(`      round trip  : ${rtt} ms`);
console.log(`      this PC is  : ${Math.abs(offset).toFixed(0)} ms ${offset > 0 ? "BEHIND" : "ahead of"} the database`);

if (Math.abs(offset) > 30_000) {
  console.log("\n      Note: this machine's clock is off by more than 30s. Players in that state");
  console.log("      are exactly who this fix is for - their timer is now corrected.");
}
