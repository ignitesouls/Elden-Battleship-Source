import { BOT_TIER_SPECS, type BotTier } from "./bot.ts";
import { OPENING_MEDIAN_SECONDS, gaussian, type AimView } from "./botBrain.ts";
import {
  DLC_MAJOR_GATES,
  DLC_MINOR_GATES,
  EARLY_VALUE,
  entryPlan,
  hasDlcEntry,
  stepsTo,
  type RuleSquare,
} from "./botRules.ts";

/**
 * The bot as a crew: one simulated captain per person on the biggest fleet it faces, each playing a
 * run of their own on the boss board, each in a seat of their own on the bot's fleet.
 *
 * Every number about HOW they play comes from src/data/botRoutes.json, which is the archive (see
 * scripts/build-bot-routes.ts): what each role on a crew of this size spends its time on, what it
 * opens with, which square real players most often go to next from the one they just did, how long
 * that walk takes, when in a match a square usually falls, and how much each role hunts. On a crew of
 * three the roles come out as the Limgrave player (clears its lane, barely hunts), the flex player
 * (some of each) and the DLC player (gets entry, then hunts hardest) - nobody wrote that down, it is
 * what three-player crews actually do.
 *
 * On top of the routes sit the rules (botRules.ts): a captain cannot do a square before what it
 * needs, cannot touch the DLC before entry, and stops for the early-value bosses on the way. Each
 * captain keeps their OWN kills, because each one is playing their own game - a teammate's Radahn
 * does not open Nokron for you.
 *
 * Aim (botBrain.aimView) leans on the route as hard as the tier and the role say. Once every ship
 * still afloat has been found, captains drop their routes and go to finish them (the tier's
 * `endgame`) - except Chud, who plays his route to the end.
 *
 * How fast, and how hard aim leans, are calibrated in botRoutes.json so each tier lands on its pace
 * and accuracy targets (BOT_TIER_SPECS). Pure, like botBrain: the state goes in and comes out as
 * plain JSON (rooms.bot_state), and the only randomness is the `random` it is handed.
 */

export interface RouteRole {
  label: string;
  crews: number;
  kills: number;
  regions: Record<string, number>;
  openers: Record<string, number>;
  /**
   * How much this role hunts, relative to the average real player: 1 is average, below it a captain
   * who keeps to its route with a hit nearby, above it one who goes for the hit. From the archive's
   * "shots next to a crew hit" against what chance alone would put there.
   */
  hunt?: number;
}

export interface BotRoutes {
  overallGap: number;
  roles: Record<string, RouteRole[]>;
  squares: Record<string, { at: number | null; gap: number | null; n: number }>;
  next: Record<string, Record<string, number>>;
  /** Fitted by build-bot-routes.ts against the archive and the tier targets. */
  calibration?: {
    /** Walk multiplier per crew size that puts Tarnished on a real crew's pace. */
    walk: Record<string, number>;
    /** Per tier, the power aim's pull is raised to (before the role's own hunt). */
    aim: Record<string, number>;
    /**
     * Per tier, a correction on the walk scale. A tier that leans hard on aim crosses the map to
     * finish ships, which is slower than walking its route; this puts it back on its pace.
     */
    tierWalk?: Record<string, number>;
  };
}

/** One thing a captain is on the way to do. `cell` null is a kill off this board, which fires nothing. */
export interface Step {
  name: string | null;
  cell: number | null;
}

export interface Captain {
  role: number;
  label: string;
  /** Match second the step at the head of the queue is done. */
  at: number;
  last: string | null;
  kills: string[];
  queue: Step[];
}

export interface CrewState {
  v: 1;
  captains: Captain[];
}

/** Everything fixed for a match. */
export interface CrewWorld {
  tier: BotTier;
  routes: BotRoutes;
  /** bossPrereqs.json - read for its gates, alongside the bot's own rules. */
  shared: Record<string, unknown>;
  /** The board as played: the square on each cell. */
  board: (RuleSquare | undefined)[];
  /** Every square in the game, for gates that are not on this board. */
  lookup: (name: string) => RuleSquare | undefined;
  /** Overrides for the calibration in `routes`, used while fitting it. */
  tune?: { walk?: number; aim?: number };
}

/** What changes between turns: what has been fired at, and what aim makes of the board. */
export interface CrewTurn {
  fired: Set<number>;
  aim: AimView;
  random: () => number;
}

/** A shot one captain fires: where, who, and the match second their kill landed. */
export interface CrewShot {
  cell: number;
  captain: number;
  at: number;
}

/** Biggest crew size with roles of its own in botRoutes.json. */
const MAX_ROLES = 4;

/** Early-value bosses stay attractive until DLC entry, or this far in for a captain who never goes. */
const EARLY_WINDOW_SECONDS = 40 * 60;

/** A square this much before its usual time is still fair game; past this, it fades. */
const TIMING_SLACK_SECONDS = 15 * 60;
const TIMING_FADE_SECONDS = 25 * 60;

/** How much each detour kill (a gate off the board, still to do) costs a square's appeal. */
const DETOUR_PENALTY = 0.4;

/** How decisively a tier follows the route real players take next, as the exponent on that pull. */
const ROUTE_SHARPNESS: Record<BotTier, number> = { chud: 1, tarnished: 1.5, sweat: 2, shaker: 2.5 };

/** Aim strength before calibration exists - see BotRoutes.calibration. */
const DEFAULT_AIM: Record<BotTier, number> = { chud: 0, tarnished: 1, sweat: 1.5, shaker: 2 };

/** A captain with nothing left to do waits this long and looks again. */
const IDLE_SECONDS = 600;

export function rolesFor(routes: BotRoutes, crew: number): RouteRole[] {
  const size = Math.max(1, Math.min(MAX_ROLES, crew));
  const base = routes.roles[String(size)] ?? [];
  if (crew <= MAX_ROLES) return base;
  // A fifth or sixth captain is more of the middle, which is what extra players on real crews are.
  const middle = base.slice(1, -1);
  const extra = Array.from({ length: crew - MAX_ROLES }, (_, i) => middle[i % Math.max(1, middle.length)] ?? base[0]);
  return [...base.slice(0, -1), ...extra, base[base.length - 1]];
}

/**
 * The seat names for a crew of this size: "Sweat" alone, or "Sweat · Limgrave", "Sweat · Flex",
 * "Sweat · DLC". A role that appears twice is numbered.
 */
export function captainNames(routes: BotRoutes, tier: BotTier, crew: number): string[] {
  const name = BOT_TIER_SPECS[tier].name;
  if (crew <= 1) return [name];
  const labels = rolesFor(routes, crew).map((r) => (r.label === "dlc" ? "DLC" : r.label.charAt(0).toUpperCase() + r.label.slice(1)));
  const seen: Record<string, number> = {};
  return labels.map((l) => {
    seen[l] = (seen[l] ?? 0) + 1;
    const total = labels.filter((x) => x === l).length;
    return `${name} · ${total > 1 ? `${l} ${seen[l]}` : l}`;
  });
}

/** The crew size's walk scale, times this tier's own correction - see BotRoutes.calibration. */
function walkScale(world: CrewWorld, crew: number): number {
  if (world.tune?.walk !== undefined) return world.tune.walk;
  const cal = world.routes.calibration;
  return (cal?.walk[String(Math.max(1, Math.min(MAX_ROLES, crew)))] ?? 1) * (cal?.tierWalk?.[world.tier] ?? 1);
}

function aimStrength(world: CrewWorld): number {
  return world.tune?.aim ?? world.routes.calibration?.aim[world.tier] ?? DEFAULT_AIM[world.tier];
}

/**
 * Seconds a kill takes from the one before: the archive's walk to that square, scaled to this crew
 * size and tier.
 *
 * No walls added on top - these are real walks, and the boss somebody died to six times is already in
 * them. A kill off the board costs half a walk: the walk to the next real square was measured with
 * that kind of errand already inside it.
 */
function walk(step: Step, world: CrewWorld, crew: number, random: () => number): number {
  if (step.name === null) return IDLE_SECONDS;
  const base = world.routes.squares[step.name]?.gap ?? world.routes.overallGap;
  const gap = (base * walkScale(world, crew)) / BOT_TIER_SPECS[world.tier].pace;
  return Math.max(30, Math.round(gap * Math.exp(0.35 * gaussian(random)) * (step.cell === null ? 0.5 : 1)));
}

/** Seconds a gate costs when planning a route: its usual walk. */
function priceOf(world: CrewWorld) {
  return (name: string) => world.routes.squares[name]?.gap ?? world.routes.overallGap;
}

function weightedPick<T>(items: { item: T; score: number }[], random: () => number): T | null {
  const total = items.reduce((s, x) => s + x.score, 0);
  if (!(total > 0)) return null;
  let r = random() * total;
  for (const x of items) {
    r -= x.score;
    if (r <= 0) return x.item;
  }
  return items[items.length - 1].item;
}

/** Cells some captain is already on the way to - nobody else plans for them. */
function claimed(state: CrewState): Set<number> {
  const out = new Set<number>();
  for (const c of state.captains) for (const s of c.queue) if (s.cell !== null) out.add(s.cell);
  return out;
}

/** The captain's next errand: the gates it still needs, then the square. */
function chooseRoute(c: Captain, state: CrewState, world: CrewWorld, turn: CrewTurn, t: number, mayFinish = true): Step[] {
  const role = rolesFor(world.routes, state.captains.length)[c.role];
  const kills = new Set(c.kills);
  const entry = hasDlcEntry(kills);
  const dlcRole = (role?.regions.dlc ?? 0) >= 0.3;
  const taken = claimed(state);
  const price = priceOf(world);
  const lean = aimStrength(world) * (role?.hunt ?? 1);
  const spec = BOT_TIER_SPECS[world.tier];
  // A tier that finishes at once (Shaker) goes for a found ship the moment there is one; the others
  // keep scouting until every ship still afloat has been found.
  const endgame =
    mayFinish && (spec.finishAtOnce ? turn.aim.lead.size > 0 : turn.aim.endgame) && turn.random() < spec.endgame;

  // Where real players went next from the square this captain just did - or, for a first kill, what
  // players in this role open with.
  const from = c.last ? world.routes.next[c.last] : role?.openers;
  const fromTotal = from ? Object.values(from).reduce((s, n) => s + n, 0) : 0;

  // Every board square nobody has fired at, claimed or not. A gate that is on the board is never
  // done off it: whoever kills it fires it, and a square someone else is already heading for is not
  // somewhere this captain can quietly pass through without a shot.
  const onBoard = new Map<string, number>();
  world.board.forEach((sq, cell) => {
    if (sq && !turn.fired.has(cell)) onBoard.set(sq.name, cell);
  });

  // A square that would finish a found ship but sits behind a gate still standing on the board -
  // Godfrey beside a hit while DTS is unfired - is unreachable until somebody does the gate. A crew
  // knows that, so the gate takes on the pull of what it unlocks: "we need DTS to get to Godfrey".
  // Without this a quarter of the bot's chances to finish a ship were simply never taken.
  const unlocks = new Map<number, number>();
  for (const cell of turn.aim.lead) {
    const sq = world.board[cell];
    if (!sq || kills.has(sq.name)) continue;
    for (const gate of stepsTo(sq.name, kills, world.lookup, world.shared, price)) {
      const gateCell = onBoard.get(gate);
      if (gateCell !== undefined) unlocks.set(gateCell, Math.max(unlocks.get(gateCell) ?? 0, turn.aim.pull[cell]));
    }
  }

  const options: { item: Step[]; score: number }[] = [];
  world.board.forEach((sq, cell) => {
    if (!sq || turn.fired.has(cell) || taken.has(cell) || kills.has(sq.name)) return;
    if (endgame && !turn.aim.lead.has(cell) && !unlocks.has(cell)) return;
    const steps = stepsTo(sq.name, kills, world.lookup, world.shared, price);
    if (steps.some((s) => onBoard.has(s))) return;

    const detour = Math.pow(DETOUR_PENALTY, steps.length);
    const hunt = Math.pow(Math.max(turn.aim.pull[cell], unlocks.get(cell) ?? 0), lean);
    let score: number;
    if (endgame) {
      // Finishing: the route no longer matters, only what is left to sink and how far away it is.
      score = hunt * detour;
    } else {
      const lane = (role?.regions[sq.region ?? ""] ?? 0) + 0.02;
      const follow = 1 + 10 * (fromTotal > 0 ? (from?.[sq.name] ?? 0) / fromTotal : 0);
      const usual = world.routes.squares[sq.name]?.at ?? 3000;
      const timing = usual <= t + TIMING_SLACK_SECONDS ? 1 : Math.exp(-(usual - t - TIMING_SLACK_SECONDS) / TIMING_FADE_SECONDS);
      const early = EARLY_VALUE.has(sq.name) && (!entry || t < EARLY_WINDOW_SECONDS) ? 4 : 1;
      const gate = dlcRole && !entry && (DLC_MAJOR_GATES.includes(sq.name) || DLC_MINOR_GATES.includes(sq.name)) ? 5 : 1;
      // Route sharpness is not applied to the lane, which is the role's own measured split and would
      // otherwise come out narrower than any real crew plays it.
      score = lane * timing * early * gate * detour * Math.pow(follow, ROUTE_SHARPNESS[world.tier]) * hunt;
    }
    if (score > 0) options.push({ item: [...steps.map((name) => ({ name, cell: null })), { name: sq.name, cell }], score });
  });

  const picked = weightedPick(options, turn.random);
  if (picked) return picked;
  // In the endgame with nothing this captain can reach to finish, it carries on with its route.
  if (endgame) return chooseRoute(c, state, world, turn, t, false);
  // Nothing on the board for this captain. A DLC player without entry goes and gets it; anyone else
  // waits and looks again, the way a captain with an empty list goes off and does something.
  if (dlcRole && !entry) {
    const plan = entryPlan(kills, world.lookup, world.shared, price).filter((name) => !onBoard.has(name));
    if (plan.length > 0) return plan.map((name) => ({ name, cell: null }));
  }
  return [{ name: null, cell: null }];
}

function plan(c: Captain, state: CrewState, world: CrewWorld, turn: CrewTurn, from: number) {
  if (c.queue.length === 0) c.queue = chooseRoute(c, state, world, turn, from);
  c.at = from + walk(c.queue[0], world, state.captains.length, turn.random);
}

/** A fresh crew for a match whose firing has just opened. */
export function newCrew(world: CrewWorld, crew: number, turn: CrewTurn): CrewState {
  const roles = rolesFor(world.routes, crew);
  const spec = BOT_TIER_SPECS[world.tier];
  const state: CrewState = {
    v: 1,
    captains: roles.map((r, i) => ({ role: i, label: r.label, at: 0, last: null, kills: [], queue: [] })),
  };
  for (const c of state.captains) {
    // Their first square comes after a real run's opening, not after one walk - see openingSeconds.
    c.at = Math.round(OPENING_MEDIAN_SECONDS * spec.openingFactor * Math.exp(0.36 * gaussian(turn.random)));
    c.queue = chooseRoute(c, state, world, turn, c.at);
  }
  return state;
}

/** Match second the crew next does anything. */
export function crewDue(state: CrewState): number {
  return Math.min(...state.captains.map((c) => c.at));
}

/**
 * Plays the crew forward to `now`: every captain whose kill is done does it, and sets off on the
 * next. Returns the shots fired, in order, each with its captain and the second it landed. Mutates
 * `state`.
 *
 * `onShot` fires each shot and hands back what aim makes of the board NOW - with that shot's verdict
 * in it - before the captain chooses where to go next. A real captain sees "hit" the moment they
 * fire; one that chose its next square before hearing would follow every hit up a whole walk late,
 * and that alone held the bot to about 36% whatever its aim.
 *
 * A captain more than two minutes behind is brought up to now first, so a driver that was away for
 * twenty minutes gets a bot that carries on, not one that empties a backlog in one breath.
 */
export async function playCrew(
  state: CrewState,
  world: CrewWorld,
  turn: CrewTurn,
  now: number,
  onShot: (shot: CrewShot) => Promise<AimView> | AimView
): Promise<CrewShot[]> {
  for (const c of state.captains) if (c.at < now - 120) c.at = now;
  const cellOf = new Map<string, number>();
  world.board.forEach((sq, cell) => sq && cellOf.set(sq.name, cell));
  const out: CrewShot[] = [];
  for (let guard = 0; guard < 64; guard++) {
    const c = state.captains.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)[0];
    if (!c) break;
    const captain = state.captains.indexOf(c);
    const step = c.queue.shift();
    if (step?.name) {
      if (!c.kills.includes(step.name)) c.kills.push(step.name);
      c.last = step.name;
    }
    // Fire on kill. A step planned as off the board whose square turns out to be on it - nobody had
    // fired it when the route was laid - fires too, so a kill on this board always leaves a shot.
    const cell = step?.cell ?? (step?.name ? cellOf.get(step.name) ?? null : null);
    if (cell !== null && !turn.fired.has(cell)) {
      const shot = { cell, captain, at: c.at };
      out.push(shot);
      turn.fired.add(cell);
      turn.aim = await onShot(shot);
    }
    plan(c, state, world, turn, c.at);
  }
  return out;
}

/** Whether the bot can run as a crew on this board: every square has route data. */
export function crewReady(world: Pick<CrewWorld, "routes" | "board">): boolean {
  return world.board.length > 0 && world.board.every((sq) => !!sq && !!world.routes.squares[sq.name]);
}
