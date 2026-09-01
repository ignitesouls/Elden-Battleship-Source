/**
 * What gets announced when the water gives something up, and in what order.
 *
 * Two sources read this: the sound, and the on-screen alert. They have to agree - a stream that
 * shows a whale while the speakers stay quiet is worse than one that does neither - and they used to
 * agree only by both having the rule written into them separately.
 *
 * Every case below is one that produced a real defect or came within one line of it. The wake in
 * particular cannot be eyeballed: it needs four tentacles found, a fifth square, and a room that
 * reaches it, which is a rare enough match that the bug shipped and was found by reading rather than
 * by playing. Cheap to assert, expensive to reproduce - which is what this file is for. Run by
 * `npm run check`.
 */
import { registerHooks } from "node:module";
import type { DeepEvent } from "../src/lib/deepQueue.ts";
import type { DeepMark } from "../src/lib/deepWater.ts";

// App modules import each other without file extensions, which Vite resolves and Node does not.
// Same shim as check-deep-water, and needed here for the same reason: deepQueue pulls in a real
// value from deepLabels, so the chain has to resolve at runtime rather than being erased as types.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { freshDeepEvents, deepKey } = await import("../src/lib/deepQueue.ts");

let fails = 0;
function ok(name: string, cond: boolean) {
  console.log((cond ? "  ok   " : "  FAIL ") + name);
  if (!cond) fails++;
}

/** A find, labelled with who turned it up so the collapse can be shown to keep the right one. */
const find = (cell: number, mark: DeepMark, who = "someone"): DeepEvent<string> => ({
  cell,
  mark,
  item: who,
});

console.log("\ndeepKey - a square and what is on it");
ok("square and mark together", deepKey(7, "tentacle") === "7:tentacle");
ok("the same square with a new mark is a different key", deepKey(7, "tentacle") !== deepKey(7, "sleeper"));
ok("...which is what makes the wake announceable at all", deepKey(7, "sleeper") === "7:sleeper");

console.log("\nthe priming pass");
{
  const first = freshDeepEvents([find(1, "whale"), find(2, "bottle")], null);
  ok("nothing is fresh on the first pass", first.fresh.length === 0);
  ok("...but everything present is remembered", first.keys.size === 2);
  ok("...including by exact key", first.keys.has("1:whale") && first.keys.has("2:bottle"));
}

console.log("\nan ordinary find");
{
  const seen = new Set(["1:whale"]);
  const tick = freshDeepEvents([find(1, "whale"), find(2, "bottle", "Marchbanks")], seen);
  ok("the new one is announced", tick.fresh.length === 1);
  ok("...and it is the new one", tick.fresh[0] === "Marchbanks");
  ok("the old one is not announced again", !tick.fresh.includes("someone"));
  ok("both are remembered for next time", tick.keys.size === 2);
}

console.log("\nnothing new");
{
  const seen = new Set(["1:whale", "2:bottle"]);
  ok("a quiet tick announces nothing", freshDeepEvents([find(1, "whale"), find(2, "bottle")], seen).fresh.length === 0);
}

console.log("\nCthulhu wakes - four squares, ONE event");
{
  // Three tentacles already found and announced. The fourth shot lands and every one of them turns.
  const seen = new Set(["10:tentacle", "20:tentacle", "30:tentacle"]);
  const tick = freshDeepEvents(
    [
      find(10, "sleeper", "first"),
      find(20, "sleeper", "second"),
      find(30, "sleeper", "third"),
      find(40, "sleeper", "the waker"),
    ],
    seen
  );
  ok("four changed squares announce ONCE", tick.fresh.length === 1);
  ok("...credited to whoever woke him, not whoever was first", tick.fresh[0] === "the waker");
  ok("all four squares are remembered", tick.keys.size === 4);
}

console.log("\nheadlines go first");
{
  const seen = new Set(["10:tentacle"]);
  // A bottle and the waking in the same tick. The bottle sorts first by position.
  const tick = freshDeepEvents([find(5, "bottle", "a bottle"), find(10, "sleeper", "the waking")], seen);
  ok("both survive - nothing is dropped", tick.fresh.length === 2);
  ok("the waking is announced first", tick.fresh[0] === "the waking");
  ok("...and the ordinary find still follows", tick.fresh[1] === "a bottle");
}

console.log("\nIgon, the other two-stage find");
{
  const seen = new Set(["8:igon"]);
  const tick = freshDeepEvents([find(8, "igonAvenged", "avenged")], seen);
  ok("the same square with his later face is news", tick.fresh.length === 1);
  ok("...and it is a headline too", tick.fresh[0] === "avenged");
}

console.log("\nAlexander, freed on the square he was stuck in");
{
  const seen = new Set(["4:jar"]);
  const tick = freshDeepEvents([find(4, "jarFree", "out at last")], seen);
  ok("stuck and freed are different finds", tick.fresh.length === 1);
  ok("...on the one square", tick.fresh[0] === "out at last");
}

console.log("\ntwo different crews, one tick");
{
  const seen = new Set<string>();
  const tick = freshDeepEvents([find(1, "bottle", "blue"), find(2, "whale", "red")], seen);
  ok("different finds are NOT collapsed together", tick.fresh.length === 2);
  ok("...so neither crew is silently dropped", tick.fresh.includes("blue") && tick.fresh.includes("red"));
}

console.log("\ntwo of the SAME find in one tick");
{
  const seen = new Set<string>();
  // Rare, and the collapse cannot tell this from a wake - both are one mark on several squares.
  // Documented rather than fixed: announcing one bottle is a smaller wrong than announcing a wake
  // four times, and the second crew still has their square marked on every board.
  const tick = freshDeepEvents([find(1, "bottle", "blue"), find(2, "bottle", "red")], seen);
  ok("collapses to one, keeping the later", tick.fresh.length === 1 && tick.fresh[0] === "red");

  /**
   * The one case where that costs something worth naming: two sightings landing together, of which
   * only one is somebody's third. The chord rides on the sighting (see useSpectatorSfx), so if the
   * collapse keeps the other one the third goes unannounced live.
   *
   * Left alone deliberately. It needs two crews sighting her inside a single realtime tick, the
   * recap still hands out Fates Confirmed either way, and the alternative is keying the collapse on
   * the square - which is the change that would announce a wake four times over.
   */
  const sails = freshDeepEvents([find(7, "dutchman", "third"), find(19, "dutchman", "ordinary")], new Set());
  ok("two sightings in one tick still collapse", sails.fresh.length === 1);
}

console.log("\nan empty sea");
{
  ok("no finds, nothing fresh", freshDeepEvents([], new Set()).fresh.length === 0);
  ok("no finds, nothing remembered", freshDeepEvents([], new Set()).keys.size === 0);
  ok("an empty first pass still primes", freshDeepEvents([], null).fresh.length === 0);
}

console.log(fails === 0 ? "\nall deep alert checks passed\n" : `\n${fails} deep alert checks FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
