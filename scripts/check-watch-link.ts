/**
 * The streamer's public watch link.
 *
 * This URL is unusual on this site in that it is meant to be BROADCAST - pasted into a Twitch panel,
 * put behind a !watch command, said out loud on stream. Every other cross-match identity here is a
 * secret (the ingest token fires shots, the rejoin code hands over the seat, the overlay token
 * unlocks a fleet), and the entire argument for this one being a plain name instead of a random
 * string is that it carries nothing worth protecting.
 *
 * That argument has an expiry date unless something guards it. The day somebody appends a token to
 * this URL - to save a round trip, to carry a viewer preference, to identify who is watching - a
 * streamer starts publishing a credential to their whole audience, and nothing on screen will say
 * so. So: no query string, ever, and no credential-shaped thing anywhere in it.
 *
 * The rules that actually keep the audience out of the other crew's board are SQL and are asserted
 * nowhere in Node, because they cannot be: they are the absence of a `players` row and the consent
 * check inside watch_handle_fleet. See 20260905000000_watch_handles.sql, which spells both out.
 *
 * Run by `npm run check`.
 */
import { normalizeHandle, watchUrl, WATCH_ROUTE } from "../src/lib/watchLink.ts";

let fails = 0;
function ok(name: string, cond: boolean) {
  console.log((cond ? "  ok   " : "  FAIL ") + name);
  if (!cond) fails++;
}

const BASE = "https://example.test/Elden-Battleship/";

console.log("\nthe handle");
ok("a Twitch name passes through unchanged", normalizeHandle("ignitesouls") === "ignitesouls");
// Twitch shows logins capitalised in its own UI, so this is the copy-paste people will actually do.
ok("capitals are folded, because Twitch displays them", normalizeHandle("IgniteSouls") === "ignitesouls");
ok("surrounding space is dropped", normalizeHandle("  ignitesouls \n") === "ignitesouls");

console.log("\nthe URL");
const url = watchUrl(BASE, "IgniteSouls");
ok("is built off the caller's base, not a hardcoded origin", url.startsWith(BASE));
ok("routes to the watch page", url === `${BASE}#/${WATCH_ROUTE}/ignitesouls`);

// The one that matters. Stated as "no ? at all" rather than as a list of forbidden parameter names,
// because the failure this is guarding against is somebody adding a parameter nobody thought of.
ok("carries no query string whatsoever", !url.includes("?"));
ok(
  "carries nothing credential-shaped",
  !/token|key|code|secret|auth|session/i.test(url.slice(BASE.length))
);

// A real Twitch login is [a-zA-Z0-9_] and never needs escaping, but this function is also handed
// whatever sits in a text field - and a slash in there would invent a route segment.
const hostile = watchUrl(BASE, "a/b?c=d#e");
ok("a handle cannot invent a route segment", hostile.split(`#/${WATCH_ROUTE}/`)[1] === "a%2Fb%3Fc%3Dd%23e");
ok("a handle cannot smuggle in a query string", !hostile.slice(BASE.length).includes("?"));

console.log(fails === 0 ? "\nAll watch link checks passed." : `\n${fails} watch link check(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
