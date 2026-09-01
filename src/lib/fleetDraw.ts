/**
 * The team randomiser, as pure data.
 *
 * Everything in here is deterministic from one 32-bit seed. That is the whole
 * point: the host draws, broadcasts the seed, and every other person in the
 * lobby replays the same draw from it. Nothing about the result travels over
 * the wire except the seed and the roster it was drawn against, so a draw
 * costs one small realtime message and no database rows at all.
 *
 * -- What "the same" means, exactly ----------------------------------------
 *
 * The CHOREOGRAPHY is shared: who is on which team, which ship commits at
 * which moment, which side each ship feints at first, which hull she sails.
 * The LAYOUT is not, and cannot be - a lobby open on a phone and one on a
 * projector do not have the same number of pixels to put ships in. So every
 * position here is normalised to 0..1 and mapped to the stage at render time.
 *
 * Two people watching therefore see the same draw told at the same pace, laid
 * out for the screen each of them actually has. Trying to force identical
 * pixels would mean letter-boxing the smaller window, which is a worse answer
 * to a problem nobody has.
 */

/** How long the fleet takes to sort itself out, in milliseconds. */
export const DRIFT_MS = 28_000;

/** Nobody commits in the first stretch - the meandering has to establish. */
const COMMIT_FLOOR_MS = 3_000;

/** Ships stop feinting this long before they commit, so the last turn reads. */
const FEINT_QUIET_MS = 2_200;

export const MIN_TEAMS = 2;
export const MAX_TEAMS = 6;

/**
 * mulberry32 - small, fast, and good enough that a shuffle built on it is not
 * detectably lumpy at the sizes a lobby reaches. See scripts/check-fleet-draw.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh seed for a new draw. Crypto so nobody can predict the next one. */
export function newSeed(): number {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] >>> 0;
}

/** Unbiased index in [0, n): reject the tail that would wrap unevenly. */
function below(rng: () => number, n: number): number {
  // rng() is already uniform on [0,1), so the modulo bias the crypto path has
  // to reject does not arise here; the floor is exact for the sizes we use.
  return Math.min(n - 1, Math.floor(rng() * n));
}

function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const k = below(rng, i + 1);
    const t = a[i];
    a[i] = a[k];
    a[k] = t;
  }
  return a;
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Assigns n players across t teams, returning a team index per player.
 *
 * When n does not divide evenly the spare berths have to go somewhere, and
 * handing them to teams 1..r every time would quietly favour the low-numbered
 * teams - on a 5-player, 2-team draw, team 1 would ALWAYS be the one with
 * three. So the team order is shuffled too: every team is equally likely to be
 * one of the larger ones, which holds every player at exactly 1/t for every
 * team. scripts/check-fleet-draw asserts that over a large sample.
 */
export function assignTeams(rng: () => number, n: number, teams: number): number[] {
  const base = Math.floor(n / teams);
  const spare = n % teams;
  const order = shuffled(rng, range(teams));

  const sizes = new Array<number>(teams);
  for (let i = 0; i < teams; i++) sizes[order[i]] = base + (i < spare ? 1 : 0);

  const players = shuffled(rng, range(n));
  const out = new Array<number>(n);
  let at = 0;
  for (let team = 0; team < teams; team++) {
    for (let s = 0; s < sizes[team]; s++) out[players[at++]] = team;
  }
  return out;
}

/** One ship's scripted part in the draw. Positions are normalised 0..1. */
export interface ShipPlan {
  /** Index into the roster this plan was built for. */
  index: number;
  team: number;
  /** Which of the five rigs she sails. */
  hull: number;
  /** ms from the start of the draw at which she gives up feinting and commits. */
  commitAt: number;
  /** ms offsets at which she starts a feint, with the zone she runs at. */
  feints: { at: number; zone: number }[];
  /** Where she starts, normalised. */
  start: { x: number; y: number };
  /** Her own offset off a tidy berth, normalised, so no side lines up square. */
  berthJitter: { x: number; y: number };
  /** Her private swing at anchor. */
  orbit: { phase: number; speed: number; rx: number; ry: number };
  /** Which way she happens to be pointing at the start. */
  face: 1 | -1;
}

export interface DrawPlan {
  seed: number;
  teams: number;
  /** Team index per roster entry. */
  assignment: number[];
  ships: ShipPlan[];
}

/**
 * Builds the whole draw from a seed.
 *
 * Called identically on every client. The order of rng() calls below is part
 * of the contract - insert a draw in the middle of this and every client on an
 * older build tells a different story from the same seed. Add at the end.
 */
export function planDraw(seed: number, count: number, teams: number): DrawPlan {
  const rng = makeRng(seed);
  const assignment = assignTeams(rng, count, teams);

  const ships: ShipPlan[] = [];
  for (let i = 0; i < count; i++) {
    const commitAt = COMMIT_FLOOR_MS + rng() * DRIFT_MS;

    // Feints run from early on until shortly before she commits. She may get
    // none at all if she is one of the first to make up her mind, which is
    // correct - the early ships are the ones that look decisive.
    const feints: { at: number; zone: number }[] = [];
    let t = 700 + rng() * 2200;
    while (t < commitAt - FEINT_QUIET_MS) {
      feints.push({ at: t, zone: below(rng, teams) });
      t += 2600 + rng() * 3400;
    }

    ships.push({
      index: i,
      team: assignment[i],
      hull: below(rng, 5),
      commitAt,
      feints,
      start: { x: 0.08 + rng() * 0.84, y: 0.1 + rng() * 0.8 },
      berthJitter: { x: (rng() - 0.5) * 0.05, y: (rng() - 0.5) * 0.02 },
      orbit: {
        phase: rng() * Math.PI * 2,
        speed: 0.1 + rng() * 0.13,
        rx: 13 + rng() * 12,
        ry: 5 + rng() * 6,
      },
      face: rng() < 0.5 ? -1 : 1,
    });
  }

  return { seed, teams, assignment, ships };
}

/**
 * What the host puts on the wire. Deliberately tiny: the roster travels as
 * names so a late joiner rendering the draw shows the same people in the same
 * order even though their own players list has since changed underneath them.
 */
export interface DrawMessage {
  seed: number;
  teams: number;
  names: string[];
  /** Author's clock at the moment of the draw, for latecomer catch-up. */
  startedAt: number;
}

export function isDrawMessage(v: unknown): v is DrawMessage {
  if (v === null || typeof v !== "object") return false;
  const m = v as Partial<DrawMessage>;
  return (
    typeof m.seed === "number" &&
    Number.isFinite(m.seed) &&
    typeof m.teams === "number" &&
    m.teams >= MIN_TEAMS &&
    m.teams <= MAX_TEAMS &&
    Array.isArray(m.names) &&
    m.names.length >= 2 &&
    m.names.every((n) => typeof n === "string") &&
    typeof m.startedAt === "number"
  );
}
