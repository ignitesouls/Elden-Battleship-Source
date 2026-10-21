import { BOT_TIER_SPECS, type BotTier } from "./bot.ts";
import { OPENING_MEDIAN_SECONDS, gaussian } from "./botBrain.ts";
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
 * run of their own on the boss board.
 *
 * Every number about HOW they play comes from src/data/botRoutes.json, which is the archive (see
 * scripts/build-bot-routes.ts): what each role on a crew of this size spends its time on, what it
 * opens with, which square real players most often go to next from the one they just did, how long
 * that walk takes, and when in a match a square usually falls. On a crew of three the roles come out
 * as the Limgrave player, the flex player and the DLC player - nobody wrote that down, it is what
 * three-player crews actually do.
 *
 * On top of the routes sit the rules (botRules.ts): a captain cannot do a square before what it
 * needs, cannot touch the DLC before entry, and stops for the early-value bosses on the way. Each
 * captain keeps their OWN kills, because each one is playing their own game - a teammate's Radahn
 * does not open Nokron for you.
 *
 * Aim (botBrain.aimWeights) only leans on the route. A hit gets followed up when it is near where a
 * captain is going anyway; it does not send the whole crew across the map, which is what made the
 * first version of the bot gun ships down instead of playing.
 *
 * Pure, like botBrain: the state goes in and comes out as plain JSON (rooms.bot_state), and the only
 * randomness is the `random` it is handed.
 */

export interface RouteRole {
  label: string;
  crews: number;
  kills: number;
  regions: Record<string, number>;
  openers: Record<string, number>;
}

export interface BotRoutes {
  overallGap: number;
  roles: Record<string, RouteRole[]>;
  squares: Record<string, { at: number | null; gap: number | null; n: number }>;
  next: Record<string, Record<string, number>>;
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
}

/** What changes between turns: what has been fired at, and where aim is leaning. */
export interface CrewTurn {
  fired: Set<number>;
  /** botBrain.aimWeights, one per cell. */
  aim: Float64Array;
  random: () => number;
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

/** How hard a tier commits to its best option, as the exponent on every score. */
const SHARPNESS: Record<BotTier, number> = { chud: 1, tarnished: 1.5, sweat: 2, shaker: 2.5 };

/** A captain with nothing left to do waits this long and looks again. */
const IDLE_SECONDS = 600;

function rolesFor(routes: BotRoutes, crew: number): RouteRole[] {
  const size = Math.max(1, Math.min(MAX_ROLES, crew));
  const base = routes.roles[String(size)] ?? [];
  if (crew <= MAX_ROLES) return base;
  // A fifth or sixth captain is more of the middle, which is what extra players on real crews are.
  const middle = base.slice(1, -1);
  const extra = Array.from({ length: crew - MAX_ROLES }, (_, i) => middle[i % Math.max(1, middle.length)] ?? base[0]);
  return [...base.slice(0, -1), ...extra, base[base.length - 1]];
}

/**
 * Seconds a kill takes from the one before: the archive's walk to that square, at this tier's pace.
 *
 * No walls added on top, unlike the plain bot's nextGapSeconds - these are real walks, and the boss
 * somebody died to six times is already in them. A kill off the board costs half a walk: the walk to
 * the next real square was measured with that kind of errand already inside it.
 */
function walk(step: Step, world: CrewWorld, random: () => number): number {
  if (step.name === null) return IDLE_SECONDS;
  const spec = BOT_TIER_SPECS[world.tier];
  const base = world.routes.squares[step.name]?.gap ?? world.routes.overallGap;
  // Tarnished's 165s is the field's median pace; the other tiers are that, scaled.
  const gap = base * (spec.gapSeconds / 165) * Math.exp(0.35 * gaussian(random)) * (step.cell === null ? 0.5 : 1);
  return Math.max(30, Math.round(gap));
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
function chooseRoute(c: Captain, state: CrewState, world: CrewWorld, turn: CrewTurn, t: number): Step[] {
  const role = rolesFor(world.routes, state.captains.length)[c.role];
  const kills = new Set(c.kills);
  const entry = hasDlcEntry(kills);
  const dlcRole = (role?.regions.dlc ?? 0) >= 0.3;
  const taken = claimed(state);
  const price = priceOf(world);

  // Where real players went next from the square this captain just did - or, for a first kill, what
  // players in this role open with.
  const from = c.last ? world.routes.next[c.last] : role?.openers;
  const fromTotal = from ? Object.values(from).reduce((s, n) => s + n, 0) : 0;

  const unfired = new Map<string, number>();
  world.board.forEach((sq, cell) => {
    if (sq && !turn.fired.has(cell) && !taken.has(cell)) unfired.set(sq.name, cell);
  });

  const options: { item: Step[]; score: number }[] = [];
  world.board.forEach((sq, cell) => {
    if (!sq || turn.fired.has(cell) || taken.has(cell) || kills.has(sq.name)) return;
    const steps = stepsTo(sq.name, kills, world.lookup, world.shared, price);
    // A gate that is ON the board gets done as its own square first; it is a candidate in its own
    // right, and doing it off the board would waste the shot.
    if (steps.some((s) => unfired.has(s))) return;

    const lane = (role?.regions[sq.region ?? ""] ?? 0) + 0.02;
    const follow = 1 + 10 * (fromTotal > 0 ? (from?.[sq.name] ?? 0) / fromTotal : 0);
    const usual = world.routes.squares[sq.name]?.at ?? 3000;
    const timing = usual <= t + TIMING_SLACK_SECONDS ? 1 : Math.exp(-(usual - t - TIMING_SLACK_SECONDS) / TIMING_FADE_SECONDS);
    const early = EARLY_VALUE.has(sq.name) && (!entry || t < EARLY_WINDOW_SECONDS) ? 4 : 1;
    const gate = dlcRole && !entry && (DLC_MAJOR_GATES.includes(sq.name) || DLC_MINOR_GATES.includes(sq.name)) ? 5 : 1;
    const detour = Math.pow(DETOUR_PENALTY, steps.length);
    // Sharpness applies to the route and the aim - how decisively a captain follows what usually comes
    // next and leans on a lead - but not to the lane, which is the role's own measured split and
    // would otherwise come out narrower than any real crew plays it.
    const score = lane * timing * early * gate * detour * Math.pow(follow * turn.aim[cell], SHARPNESS[world.tier]);
    if (score > 0) options.push({ item: [...steps.map((name) => ({ name, cell: null })), { name: sq.name, cell }], score });
  });

  const picked = weightedPick(options, turn.random);
  if (picked) return picked;
  // Nothing on the board for this captain. A DLC player without entry goes and gets it; anyone else
  // waits and looks again, the way a captain with an empty list goes off and does something.
  if (dlcRole && !entry) {
    const plan = entryPlan(kills, world.lookup, world.shared, price);
    if (plan.length > 0) return plan.map((name) => ({ name, cell: null }));
  }
  return [{ name: null, cell: null }];
}

function plan(c: Captain, state: CrewState, world: CrewWorld, turn: CrewTurn, from: number) {
  if (c.queue.length === 0) c.queue = chooseRoute(c, state, world, turn, from);
  c.at = from + walk(c.queue[0], world, turn.random);
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
 * next. Returns the cells fired at, in order. Mutates `state`.
 *
 * A captain more than two minutes behind is brought up to now first, so a driver that was away for
 * twenty minutes gets a bot that carries on, not one that empties a backlog in one breath.
 */
export function playCrew(state: CrewState, world: CrewWorld, turn: CrewTurn, now: number): number[] {
  for (const c of state.captains) if (c.at < now - 120) c.at = now;
  const out: number[] = [];
  for (let guard = 0; guard < 64; guard++) {
    const c = state.captains.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)[0];
    if (!c) break;
    const step = c.queue.shift();
    if (step?.name) {
      if (!c.kills.includes(step.name)) c.kills.push(step.name);
      c.last = step.name;
    }
    if (step?.cell != null && !turn.fired.has(step.cell)) {
      out.push(step.cell);
      turn.fired.add(step.cell);
      turn.aim[step.cell] = 0;
    }
    plan(c, state, world, turn, c.at);
  }
  return out;
}

/** Whether the bot can run as a crew on this board: every square has route data. */
export function crewReady(world: Pick<CrewWorld, "routes" | "board">): boolean {
  return world.board.length > 0 && world.board.every((sq) => !!sq && !!world.routes.squares[sq.name]);
}
