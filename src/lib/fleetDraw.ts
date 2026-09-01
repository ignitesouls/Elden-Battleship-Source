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
 * The CHOREOGRAPHY is shared: who is on which team, which ship the maelstrom
 * takes at which moment, how long she is under, which hull she sails. The
 * LAYOUT is not, and cannot be - a lobby open on a phone and one on a
 * projector do not have the same number of pixels to put ships in. So every
 * position here is normalised to 0..1 and mapped to the stage at render time.
 *
 * That split is also why the order ships go down in is drawn from the seed
 * rather than taken from whoever happens to be nearest the eye. Distance is a
 * fact about one viewer's pixels; a phone and a projector would sequence the
 * same draw differently, and the draw would stop being one shared story.
 *
 * Two people watching therefore see the same draw told at the same pace, laid
 * out for the screen each of them actually has. Trying to force identical
 * pixels would mean letter-boxing the smaller window, which is a worse answer
 * to a problem nobody has.
 */

/**
 * How long the fleet takes to sort itself out, in milliseconds.
 *
 * Now the window in which every ship is TAKEN, not the window in which every
 * ship arrives - the last hull caught at the end of it is still under the
 * water for a second or two afterwards. drawLengthMs() gives the real total.
 */
export const DRIFT_MS = 28_000;

/** The funnel winds up before it can take anybody. */
export const OPEN_MS = 1_200;

/**
 * The gap between one ship going down and the next, clamped at both ends.
 *
 * Derived from the headcount rather than fixed, so the draw runs about the
 * same length whoever is in the lobby. Without the clamps a four-player draw
 * would leave seven seconds of empty water between hulls, and an eighteen-
 * player one would chew the fleet faster than a caster can name anybody.
 */
const PULL_GAP_MIN_MS = 900;
const PULL_GAP_MAX_MS = 2_600;

/** Rim to eye, the moment under, and the arc back out. */
const DESCENT_MS = 1_700;
const UNDER_MS = 320;
const FLING_MS = 1_000;

export const MIN_TEAMS = 2;
export const MAX_TEAMS = 6;

/**
 * Which lobby colour each drawn team wears, as indices into TEAM_COLORS.
 *
 * NOT the palette's own order, which opens Red then Blue. The draw is led by
 * Purple and Green because that is the pair this room actually plays - look at
 * any match by games played and it is those two. A randomiser that keeps
 * showing colours nobody uses is describing a different game.
 *
 * Cosmetic only: the draw never writes players.team, so this decides what the
 * sails are painted and nothing else.
 */
export const DRAW_TEAM_COLORS = [4, 2, 0, 1, 3, 5] as const;

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
  /** ms from the start of the draw at which the maelstrom takes her. */
  pullAt: number;
  /** How long she takes to spiral from where she was caught down to the eye. */
  descentMs: number;
  /** How long she is under before the eye throws her back out. */
  underMs: number;
  /** How long the arc out to her berth takes. */
  flingMs: number;
  /** How many turns of the funnel she makes on the way down. */
  turns: number;
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

  /**
   * The queue for the funnel: one ship at a time, in a seeded order.
   *
   * Taking them in roster order would put the same person first every draw,
   * and taking them by distance from the eye would sequence differently on
   * every screen - see the note at the top of this file.
   */
  const queue = shuffled(rng, range(count));
  const place = new Array<number>(count);
  for (let p = 0; p < count; p++) place[queue[p]] = p;

  const gap = Math.min(
    PULL_GAP_MAX_MS,
    Math.max(PULL_GAP_MIN_MS, (DRIFT_MS - OPEN_MS) / Math.max(count, 1)),
  );

  const ships: ShipPlan[] = [];
  for (let i = 0; i < count; i++) {
    ships.push({
      index: i,
      team: assignment[i],
      hull: below(rng, 5),
      // The jitter is smaller than the gap on purpose: the queue has to stay
      // legible as a queue, so no ship ever overtakes the one ahead of her.
      pullAt: OPEN_MS + place[i] * gap + rng() * Math.min(260, gap * 0.3),
      descentMs: DESCENT_MS * (0.9 + rng() * 0.24),
      underMs: UNDER_MS * (0.7 + rng() * 0.9),
      flingMs: FLING_MS * (0.85 + rng() * 0.3),
      turns: 1.1 + rng() * 0.7,
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

/** How long this plan runs, first wind-up to last hull in her berth. */
export function drawLengthMs(plan: DrawPlan): number {
  let most = 0;
  for (const s of plan.ships) {
    most = Math.max(most, s.pullAt + s.descentMs + s.underMs + s.flingMs);
  }
  return most;
}

/** The same number before there is a plan, for the host's estimate. */
export function estimateDrawMs(count: number): number {
  return drawLengthMs(planDraw(1, Math.max(count, 2), 2));
}

/**
 * Which story a message is telling.
 *
 * Bumped when the choreography changed from drift-and-commit to the
 * maelstrom. A seed alone is not enough to replay a draw - it only means
 * anything against the script that reads it - so a v1 message arriving at a
 * v2 client would replay the right teams to entirely the wrong picture, in
 * lockstep with a host who is watching something else. Cheaper to notice.
 */
export const DRAW_VERSION = 2;

/**
 * What the host puts on the wire. Deliberately tiny: the roster travels as
 * names so a late joiner rendering the draw shows the same people in the same
 * order even though their own players list has since changed underneath them.
 */
export interface DrawMessage {
  /** DRAW_VERSION at the host's build. Absent on anything built before v2. */
  v: number;
  seed: number;
  teams: number;
  names: string[];
  /** Author's clock at the moment of the draw, for latecomer catch-up. */
  startedAt: number;
}

/** Everything but the version, so a mismatch can be told from a malformed message. */
function isDrawShaped(v: unknown): v is Omit<DrawMessage, "v"> & { v?: unknown } {
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

export function isDrawMessage(v: unknown): v is DrawMessage {
  return isDrawShaped(v) && v.v === DRAW_VERSION;
}

/** A real draw from a build that tells it differently. Worth saying out loud. */
export function isStaleDrawMessage(v: unknown): boolean {
  return isDrawShaped(v) && v.v !== DRAW_VERSION;
}
