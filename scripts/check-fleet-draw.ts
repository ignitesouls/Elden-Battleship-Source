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
import { assignTeams, makeRng, planDraw, MAX_TEAMS, MIN_TEAMS } from "../src/lib/fleetDraw.ts";

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
  "including the order ships commit in",
  a.ships.every((s, i) => s.commitAt === b.ships[i].commitAt),
);

check(
  "and every ship commits inside the drift window",
  a.ships.every((s) => s.commitAt >= 3000 && s.commitAt <= 3000 + 28_000),
  `latest ${Math.round(Math.max(...a.ships.map((s) => s.commitAt)))}ms`,
);

check(
  "and no ship feints after she has committed",
  a.ships.every((s) => s.feints.every((f) => f.at < s.commitAt)),
);

check(
  "and every feint runs at a team that exists",
  a.ships.every((s) => s.feints.every((f) => f.zone >= 0 && f.zone < a.teams)),
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
