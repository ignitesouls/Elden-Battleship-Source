/**
 * The team randomiser has to be fair, and it has to be fair in the way people
 * will actually accuse it of not being.
 *
 * Wheel of Names is trusted because it belongs to nobody. A randomiser the
 * host runs on the host's own machine does not get that for free, so the
 * claim has to be checkable here rather than asserted in a comment.
 *
 * Three things are tested:
 *
 *   1. Every player lands on every team an equal share of the time. The trap
 *      is uneven headcounts: five into two must not mean team 1 always has
 *      three, which is what a naive "first r teams get the spare" does.
 *   2. The same seed gives the same draw, on any machine and any day. That is
 *      what lets the lobby ship one number instead of a whole choreography.
 *   3. Different seeds give different draws, which sounds too obvious to test
 *      until a refactor accidentally makes the rng stateless.
 */
import {
  assignTeams,
  drawLengthMs,
  makeRng,
  planDraw,
  DRIFT_MS,
  MAX_TEAMS,
  MIN_TEAMS,
  OPEN_MS,
} from "../src/lib/fleetDraw.ts";

let failures = 0;

function check(what: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok   ${what}${detail ? ` - ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`  FAIL ${what}${detail ? ` - ${detail}` : ""}`);
  }
}

/* ---- 1. every player, every team, an equal share ------------------------ */

const TRIALS = 40_000;

for (const [n, t] of [
  [12, 2], // the ordinary case
  [5, 2],  // odd into two - the one that exposes a lazy remainder
  [7, 3],  // one spare
  [8, 3],  // two spares
  [11, 4],
  [13, 6], // the widest split we allow
] as const) {
  const counts: number[][] = Array.from({ length: n }, () => new Array(t).fill(0));

  for (let trial = 0; trial < TRIALS; trial++) {
    const rng = makeRng((trial * 2654435761) >>> 0);
    const a = assignTeams(rng, n, t);
    for (let p = 0; p < n; p++) counts[p][a[p]]++;
  }

  const expected = 1 / t;
  // 4 sigma on a binomial share, which a fair draw clears essentially always
  // and a biased one misses by miles rather than by a hair.
  const sigma = Math.sqrt((expected * (1 - expected)) / TRIALS);
  const tolerance = 4 * sigma;

  let worst = 0;
  let worstAt = "";
  for (let p = 0; p < n; p++) {
    for (let team = 0; team < t; team++) {
      const share = counts[p][team] / TRIALS;
      const drift = Math.abs(share - expected);
      if (drift > worst) {
        worst = drift;
        worstAt = `player ${p} on team ${team + 1}: ${(share * 100).toFixed(2)}%`;
      }
    }
  }

  check(
    `${n} players into ${t} teams is even for everybody`,
    worst <= tolerance,
    `worst ${(worst * 100).toFixed(3)}pp vs ${(tolerance * 100).toFixed(3)}pp allowed, at ${worstAt}`,
  );

  // Team sizes must still be as even as the headcount permits - fairness per
  // player must not have been bought by letting the teams themselves drift.
  const rng = makeRng(99);
  const sizes = new Array(t).fill(0);
  for (const team of assignTeams(rng, n, t)) sizes[team]++;
  const spread = Math.max(...sizes) - Math.min(...sizes);
  check(
    `  and the teams differ by at most one`,
    spread <= 1,
    `sizes ${sizes.join("/")}`,
  );
}

/* ---- 2. one seed, one draw, everywhere ---------------------------------- */

const a = planDraw(123456789, 9, 3);
const b = planDraw(123456789, 9, 3);
check(
  "the same seed replays the same draw",
  JSON.stringify(a) === JSON.stringify(b),
);

check(
  "including the order the maelstrom takes them in",
  a.ships.every((s, i) => s.pullAt === b.ships[i].pullAt),
);

check(
  "and nobody is taken before the funnel has opened",
  a.ships.every((s) => s.pullAt >= OPEN_MS),
  `earliest ${Math.round(Math.min(...a.ships.map((s) => s.pullAt)))}ms`,
);

/**
 * One at a time is the entire staging. If the jitter on pullAt could ever
 * exceed the gap between two places in the queue, two ships would go down
 * together and the draw would read as the sea eating the fleet at random.
 */
for (const [n, t] of [[2, 2], [5, 2], [12, 3], [18, 6], [30, 6]] as const) {
  const plan = planDraw(20250901, n, t);
  const times = plan.ships.map((s) => s.pullAt).sort((x, y) => x - y);
  let closest = Infinity;
  for (let i = 1; i < times.length; i++) closest = Math.min(closest, times[i] - times[i - 1]);
  check(
    `${n} ships into ${t} teams go down one at a time`,
    n === 1 || closest > 0,
    `closest pair ${Math.round(closest)}ms apart`,
  );

  // A draw nobody will sit through is a draw the host stops using.
  const total = drawLengthMs(plan);
  check(
    `  and the whole draw fits in a sensible window`,
    total <= DRIFT_MS + 12_000,
    `${(total / 1000).toFixed(1)}s`,
  );
}

check(
  "every ship is under the water before she is thrown out of it",
  a.ships.every((s) => s.descentMs > 0 && s.underMs > 0 && s.flingMs > 0),
);

/* ---- 3. different seeds, different draws -------------------------------- */

const seeds = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => JSON.stringify(planDraw(s, 8, 2).assignment));
check(
  "different seeds give different draws",
  new Set(seeds).size > 1,
  `${new Set(seeds).size} distinct of ${seeds.length}`,
);

/* ---- the edges ---------------------------------------------------------- */

for (let t = MIN_TEAMS; t <= MAX_TEAMS; t++) {
  const plan = planDraw(4242, t, t);
  const sizes = new Array(t).fill(0);
  for (const team of plan.assignment) sizes[team]++;
  check(
    `${t} players into ${t} teams puts one on each`,
    sizes.every((s) => s === 1),
    `sizes ${sizes.join("/")}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} fleet-draw check(s) failed.`);
  process.exit(1);
}
console.log("\nall fleet-draw checks passed");
