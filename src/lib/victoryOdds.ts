import { rng, seedFrom } from "./seededRandom";
import { pausedMsBefore, pauseWindows, type PauseFields } from "./matchPause";
import { eliminatedTeamsFromAttacks } from "./battleshipLogic";
import type { Attack, ShipDefinition } from "../types/battleship";

/**
 * Each fleet's chance of winning, from where the match stands right now.
 *
 * -- Why this simulates rather than looks the answer up ---------------------------------------
 *
 * The obvious way to build this is to mine the record books: bucket every finished match by how
 * far ahead the leader was, count who went on to win, read the percentage off the table. That is
 * the wrong shape for THIS archive, and the reason is worth writing down so nobody rebuilds it
 * that way later.
 *
 * At the time of writing the books hold 121 matches. They are spread across four fleet counts
 * (95 duels, 16 three-way, 8 four-way, and two rooms that somehow fielded nine), ten board sizes
 * from 5x5 to 14x14, and hull totals from 8 cells to 46. A bucket keyed on the things that
 * actually move the odds ends up holding about one match, and a percentage computed from one
 * match is not a percentage. Worse, it cannot answer a shape it has never seen: the first
 * five-fleet match on a 13x13 board would have no row to read.
 *
 * The same archive is enormous, though, for the question it CAN answer - what a shot does. It
 * holds 13,202 of them, and that is what this model is fitted from (see HUNT_HIT_RATE below).
 * So the odds are not remembered, they are played out: take the board as it stands, run the rest
 * of the match a few thousand times, and count who was left standing. That handles any fleet
 * count, any board size and any hull preset without ever having seen one before, and it is
 * honest from the very first match on a brand new configuration.
 *
 * -- Why it costs nothing ---------------------------------------------------------------------
 *
 * No new table, no new query, no RPC, no migration. Every input is already on the client: the
 * `attacks` log is a PUBLIC log (`create policy "attacks select" ... using (true)`) that every
 * overlay already subscribes to for the board and the clock, and the hull totals come off the
 * room's own ship_defs. Nothing here reaches for `fleets`, which is the private table - the model
 * never needs to know where a ship IS, only how many of its cells are still standing, and the
 * public log already says that. So this leaks nothing the attack feed is not announcing anyway.
 *
 * The arithmetic is deliberately cheap enough to run in a browser source on someone's stream:
 * a duel resolves 10,000 rollouts in about 35ms, a four-way in about 80ms, and the nine-way
 * outlier in about 230ms - and it only recomputes when a shot lands, which in a real match is
 * roughly once a minute. See scripts/check-victory-odds.ts, which asserts that budget.
 *
 * -- How well it actually does ----------------------------------------------------------------
 *
 * Graded against every duel in the books that has a winner, at twenty moments each - about 4,300
 * predictions. Scored by Brier, against the only baseline that matters, which is refusing to
 * guess at all (always say 50%, which scores 0.250):
 *
 *     all moments        0.186     25% better than saying 50%
 *     first third        0.247      1% better
 *     middle third       0.182     27% better
 *     final third        0.121     52% better
 *
 * The shape of that is the honest headline, and anyone reading this number on a stream should
 * know it: THE OPENING OF A MATCH IS VERY NEARLY A COIN FLIP, and no amount of modelling makes it
 * otherwise. Two fleets thirty minutes in have barely told you anything about which one dies
 * first. What the model is genuinely good at is the back half, where its 90%+ calls win about 96%
 * of the time - which happens to be exactly the stretch a caster most wants a number for.
 *
 * That is a property of the game rather than a shortcoming to be tuned away, and it is why the
 * model is built to SAY so: early odds sit near even because they deserve to, not because they
 * have been damped. See PACE_FLOOR for the mechanism, and scripts/calibrate-victory-odds.ts to
 * re-run the whole grading against a grown archive.
 */

/**
 * How often a fleet's next shot is a HUNT - fired next to a square it has already hit - and how
 * often such a shot lands.
 *
 * Both measured over the 10,034 shots in the archive's 95 two-fleet matches, which is the clean
 * sample: a shot in a three-way match resolves against several boards at once and its result is
 * not one number. Grouped per fleet per match, in fired order, a shot counted as adjacent when it
 * was orthogonally next to a cell that fleet had already hit:
 *
 *     adjacent to a known hit    61.7%   (n = 3,547)
 *     not adjacent               21.9%   (n = 5,558)
 *     fleet's very first shot    20.5%   (n =   929)
 *
 * Two things fall out of that, and the whole model rests on them.
 *
 * The first is that COLD shots are random. 21.9% is the average share of the board these fleets'
 * hulls actually occupied, so a shot fired away from known damage lands at exactly the rate blind
 * chance predicts. That is why the cold case below needs no fitted constant at all - it is
 * hull-still-standing over cells-not-yet-fired, computed from the live board, and it corrects
 * itself as the board fills up.
 *
 * The second is that hunting is enormously effective and worth modelling separately: three times
 * the hit rate, over a third of all shots fired. A model without it is wrong in the direction that
 * matters most, because hunting is what turns a first hit into a dead fleet.
 *
 * Note what HUNT_SHARE is NOT: it is not a geometry. The model does not track which cell a shot
 * went to, only whether it was a hunting shot, because that is all the measurement supports and
 * all the outcome depends on. That is also what makes the simulation cheap - see the note on cost
 * above.
 *
 * These are constants rather than a fit run at load time on purpose. Refitting them is an
 * occasional offline job (scripts/calibrate-victory-odds.ts prints today's numbers off the live
 * archive), not something to make every viewer's browser do on every page load.
 */
export const HUNT_SHARE = 0.35;
export const HUNT_HIT_RATE = 0.617;

/**
 * Seconds one captain typically spends on one square, before the match has said otherwise.
 *
 * 150s is the middle of the range squarePace measures across the whole leaderboard (2:18 to 2:58).
 * It is a PER CAPTAIN number, so a fleet's prior is this divided by its crew - a trio really does
 * fire three times as often as a lone captain, and that is a genuine and large effect on who dies
 * first. See paceFor.
 */
export const PRIOR_SQUARE_SECONDS = 150;

/**
 * How many shots of its own a fleet must fire before the match's evidence outweighs the prior.
 *
 * A shrink rather than a threshold, because a hard cutoff makes the number jump the moment it is
 * crossed - and a stream watching a percentage snap sideways on a shot that changed nothing reads
 * it as a bug.
 */
const PACE_PRIOR_WEIGHT = 6;

/**
 * How uncertain a fleet's pace is, and why the model rolls it rather than trusting it.
 *
 * This is the correction that made the model honest early in a match, and it is worth explaining
 * because the first version had no such thing and was WORSE THAN A COIN FLIP for the first third of
 * every match. Calibrated against the archive's 95 gradable duels, it scored a Brier of 0.307
 * against 0.250 for simply always saying 50% - it called 90%+ on fleets that went on to win 68% of
 * the time, and 10-20% on fleets that won 62% of the time. Anti-predictive, confidently.
 *
 * The cause was pace. A fleet's pace is enormously decisive - double it and you win essentially
 * every time, which is real - but ten minutes into a match it is estimated from two or three gaps,
 * and two or three gaps of a heavy-tailed process is barely evidence at all. One crew getting a
 * pair of quick kills looked exactly like one crew being twice as fast, and the simulation treated
 * it as settled fact.
 *
 * So pace is no longer a number the rollout is handed; it is drawn fresh each rollout from how well
 * that fleet's pace is actually known. Early, the draw is wide and the odds sit near even because
 * they genuinely are. Late, it narrows onto what the fleet has demonstrably been doing all evening.
 * The uncertainty is a property of the estimate rather than a fudge factor applied to the output,
 * which is why it fixes the early match without flattening the late one - see the calibration
 * script, which reports the two thirds separately for exactly this reason.
 *
 * PACE_CV is the coefficient of variation of a single gap. Near 1 because kill-to-kill times behave
 * roughly like an exponential process: mostly ordinary bosses with an occasional wall, which is the
 * same tail squarePace chose the median to avoid.
 *
 * PACE_FLOOR is the part that never shrinks. Even a fleet whose pace is known perfectly from a
 * hundred gaps may not hold it: crews tire, take breaks, and hit a boss that costs them forty
 * minutes. Perfect knowledge of the past is still imperfect knowledge of the next hour.
 *
 * 0.30 is swept rather than chosen - it is the value that minimises the Brier score across the
 * whole archive, and the tradeoff either side of it is real and worth knowing before anyone
 * "improves" it:
 *
 *     floor   overall   first third   middle   final third
 *     0.12     .1879       -2.6%       28.2%      53.0%
 *     0.20     .1868       -0.8%       27.9%      52.6%
 *     0.30     .1860       +1.3%       27.4%      51.8%     <- here
 *     0.40     .1872       +2.3%       26.1%      50.5%
 *     0.55     .1897       +3.9%       23.8%      47.8%
 *
 * Widening it goes on helping the opening and goes on hurting everything after it, because a
 * looser floor is just a slower march toward saying 50% about everything. 0.30 is the last value
 * that buys an honest opening without spending the rest of the match to get it.
 */
const PACE_CV = 1.0;
const PACE_FLOOR = 0.30;

/** How wide this fleet's pace could really be, given how many gaps it has been measured over. */
function paceSigma(shots: number): number {
  const gaps = Math.max(0, shots - 1);
  return Math.sqrt((PACE_CV * PACE_CV) / (gaps + PACE_PRIOR_WEIGHT) + PACE_FLOOR * PACE_FLOOR);
}

/**
 * A standard normal, from three uniforms (Irwin-Hall).
 *
 * Box-Muller would be exact, but this sits in the innermost loop of a simulation that runs on a
 * live stream and a log/cos per fleet per rollout is real money. Three uniforms sum to a variance
 * of 1/4, so dividing the centred sum by 0.5 gives unit variance, and the tails clip at three sigma
 * - which for a pace multiplier is a feature rather than an approximation, since it is what stops a
 * rollout inventing a fleet that fires twenty times faster than it ever has.
 */
function normal(random: () => number): number {
  return (random() + random() + random() - 1.5) / 0.5;
}

/** Rollouts for the live number. 10,000 puts the standard error near 0.5 points at even odds. */
export const LIVE_ROLLOUTS = 10000;

/**
 * Rollouts for a point on the history line.
 *
 * Lower than the live number because the line is drawn from up to LINE_POINTS of them at once, and
 * a line is read as a shape rather than a value - a point being half a percent out is invisible in
 * a stroke two pixels wide, while a four-second stall while the source loads is not.
 */
export const LINE_ROLLOUTS = 500;

/** How many points the history line is sampled at, however long the match ran. */
export const LINE_POINTS = 60;

/** Where one fleet stands, as the public log describes it. */
export interface FleetState {
  team: number;
  /** Hull cells not yet struck. */
  hull: number;
  /** Hull cells the fleet started with. */
  totalHull: number;
  /** Distinct squares this fleet has fired at - the denominator a cold shot draws against. */
  fired: number;
  /** Trigger-pulls this fleet has made. */
  shots: number;
  /** Seconds between this fleet's shots, its own pace shrunk toward the prior. */
  pace: number;
  /** Captains flying it, which is most of why one fleet outpaces another. */
  crew: number;
  eliminated: boolean;
}

export interface OddsSnapshot {
  /** Team numbers, in the order `odds` is indexed. */
  teams: number[];
  /** Chance of victory, 0..1, one per team. */
  odds: number[];
  /** Rollouts nobody won - see the note on a spent board in `rollout`. Usually 0. */
  draw: number;
  /** True once only one fleet is left standing: the odds are a fact, not an estimate. */
  decided: boolean;
  /** What the odds were computed from, so a caller can show the reasoning if it wants to. */
  fleets: FleetState[];
}

/** One point on the win-probability line. */
export interface OddsPoint {
  /** Seconds on the match clock, pause-adjusted - the same clock the scorebug counts. */
  seconds: number;
  /** Chance of victory per team, indexed exactly as OddsSnapshot.teams. */
  odds: number[];
}

/** Total cells a fleet's ships occupy. */
export function totalHullCells(shipDefs: ShipDefinition[]): number {
  return shipDefs.reduce((sum, s) => sum + s.size, 0);
}

/**
 * A fleet's seconds-per-shot, its own record shrunk toward what a crew that size normally does.
 *
 * Measured between the fleet's FIRST and LAST shot rather than from the start of the match, for
 * the reason squarePace only counts gaps: the clock before a fleet's opening shot is the lobby,
 * the preparation phase and whatever the room was doing, none of which is that fleet's pace. A
 * fleet with one shot has no gap to measure and rides entirely on the prior.
 *
 * Stopped clock comes off the measurement, so a fleet does not read as slow because the match was
 * paused for ten minutes between two of its kills - the same rule matchTimeAt applies to the log.
 */
function paceFor(shotTimes: number[], crew: number, pause: PauseFields | null | undefined): number {
  const prior = PRIOR_SQUARE_SECONDS / Math.max(1, crew);
  if (shotTimes.length < 2) return prior;

  const windows = pauseWindows(pause);
  const first = shotTimes[0];
  const last = shotTimes[shotTimes.length - 1];
  const stopped = pausedMsBefore(windows, last) - pausedMsBefore(windows, first);
  const seconds = Math.max(0, last - first - stopped) / 1000;
  const gaps = shotTimes.length - 1;

  return (seconds + PACE_PRIOR_WEIGHT * prior) / (gaps + PACE_PRIOR_WEIGHT);
}

/**
 * Every fleet's standing, read from the public attack log and nothing else.
 *
 * Two de-duplications matter here, and both are about the same thing: a single trigger-pull writes
 * one `attacks` row PER OPPONENT (see the schema note above the table). Counting rows instead of
 * squares would have a fleet in a four-way match firing three times as fast as the same fleet in a
 * duel, and would strike three hull cells for one hit.
 *
 * @param upto only attacks created at or before this instant are read, which is what lets the
 * history line replay the match rather than storing one.
 */
export function fleetStates(
  attacks: Attack[],
  teams: number[],
  shipDefs: ShipDefinition[],
  players: { team: number | null }[],
  room?: PauseFields | null,
  upto?: number
): FleetState[] {
  const totalHull = totalHullCells(shipDefs);
  const eliminated = eliminatedTeamsFromAttacks(attacks, shipDefs.length);

  const crew = new Map<number, number>();
  for (const p of players) {
    if (p.team === null || p.team === undefined) continue;
    crew.set(p.team, (crew.get(p.team) ?? 0) + 1);
  }

  /** Squares each fleet has fired at, and squares each fleet has LOST - both by cell, not by row. */
  const firedCells = new Map<number, Set<number>>();
  const struckCells = new Map<number, Set<number>>();
  const shotTimes = new Map<number, number[]>();
  const seenShot = new Map<number, Set<number>>();

  for (const a of attacks) {
    if (a.cell_index < 0) continue; // the match-start marker, not a shot
    const at = new Date(a.created_at).getTime();
    if (upto !== undefined && at > upto) continue;

    let fired = firedCells.get(a.attacker_team);
    if (!fired) firedCells.set(a.attacker_team, (fired = new Set()));
    fired.add(a.cell_index);

    // One timestamp per trigger-pull, keyed by the square, so a four-way match's three rows for
    // one shot contribute one gap rather than two gaps of zero.
    let seen = seenShot.get(a.attacker_team);
    if (!seen) seenShot.set(a.attacker_team, (seen = new Set()));
    if (!seen.has(a.cell_index)) {
      seen.add(a.cell_index);
      const times = shotTimes.get(a.attacker_team);
      if (times) times.push(at);
      else shotTimes.set(a.attacker_team, [at]);
    }

    if (a.result === "hit" || a.result === "sunk") {
      let struck = struckCells.get(a.defender_team);
      if (!struck) struckCells.set(a.defender_team, (struck = new Set()));
      struck.add(a.cell_index);
    }
  }

  return teams.map((team) => {
    const times = (shotTimes.get(team) ?? []).sort((a, b) => a - b);
    const size = crew.get(team) ?? 1;
    const lost = struckCells.get(team)?.size ?? 0;
    return {
      team,
      hull: Math.max(0, totalHull - lost),
      totalHull,
      fired: firedCells.get(team)?.size ?? 0,
      shots: times.length,
      pace: paceFor(times, size, room),
      crew: size,
      eliminated: eliminated.has(team),
    };
  });
}

/**
 * Plays the rest of the match out once, and says who was left.
 *
 * Every fleet fires on its own clock rather than in turns, because that is the actual game: the
 * house rule is that you fire the instant you kill, so shots arrive whenever a captain finishes a
 * boss and a fast crew genuinely gets more of them. The jitter is a flat 0.5x-1.5x of the fleet's
 * pace, which is deliberately crude - what decides matches is the difference between one fleet's
 * pace and another's, not the shape of the noise around either.
 *
 * A fleet with no squares left to fire at stops firing rather than dying. Reaching that takes
 * firing every cell on the board without finding the enemy's last hull, which the hunt rate makes
 * near impossible - but a rollout that quietly credited the wrong fleet with a win would be a very
 * hard thing to notice from the outside, so it is handled rather than assumed away.
 *
 * @returns the winning index into `hull`, or -1 if nobody could finish.
 */
function rollout(
  cells: number,
  fleets: FleetState[],
  sigma: Float64Array,
  hull: Int32Array,
  fired: Int32Array,
  clock: Float64Array,
  pace: Float64Array,
  spent: Uint8Array,
  random: () => number
): number {
  const n = fleets.length;
  let alive = 0;
  for (let i = 0; i < n; i++) {
    hull[i] = fleets[i].eliminated ? 0 : fleets[i].hull;
    fired[i] = fleets[i].fired;
    // This rollout's guess at what the fleet's pace really is - lognormal, so a pace can be half
    // or double what was measured but never negative. See paceSigma for why it is drawn at all.
    pace[i] = fleets[i].pace * Math.exp(sigma[i] * normal(random));
    clock[i] = pace[i] * random();
    spent[i] = 0;
    if (hull[i] > 0) alive++;
  }

  while (alive > 1) {
    // Whoever's next shot lands soonest fires it.
    let s = -1;
    let soonest = Infinity;
    for (let i = 0; i < n; i++) {
      if (hull[i] > 0 && !spent[i] && clock[i] < soonest) {
        soonest = clock[i];
        s = i;
      }
    }
    if (s < 0) break; // every surviving fleet has run out of board

    clock[s] += pace[s] * (0.5 + random());
    const unfired = cells - fired[s];
    if (unfired <= 0) {
      spent[s] = 1;
      continue;
    }
    fired[s]++;

    // One trigger-pull, resolved against every opponent still standing - which is what a shot
    // does in this game, and why a three-way match ends sooner than three duels.
    const hunting = random() < HUNT_SHARE;
    for (let d = 0; d < n; d++) {
      if (d === s || hull[d] <= 0) continue;
      const p = hunting ? HUNT_HIT_RATE : hull[d] / unfired;
      if (random() < p && --hull[d] === 0) alive--;
    }
  }

  for (let i = 0; i < n; i++) if (hull[i] > 0) return i;
  return -1;
}

/**
 * Each fleet's chance of winning from the given standing.
 *
 * Seeded from the state itself rather than from Math.random, so every surface computing the same
 * moment gets the same percentage: a caster running the odds source and the scorebug side by side
 * must not see them disagree by a point because they rolled different dice.
 */
export function victoryOdds(
  fleets: FleetState[],
  boardSize: number,
  rollouts = LIVE_ROLLOUTS
): OddsSnapshot {
  const teams = fleets.map((f) => f.team);
  const standing = fleets.filter((f) => !f.eliminated && f.hull > 0);

  // Over before it is asked: one fleet left, or none at all. No point rolling dice about it.
  if (standing.length <= 1) {
    return {
      teams,
      odds: fleets.map((f) => (standing.length === 1 && f.team === standing[0].team ? 1 : 0)),
      draw: standing.length === 0 ? 1 : 0,
      decided: true,
      fleets,
    };
  }

  const cells = boardSize * boardSize;
  const n = fleets.length;
  const hull = new Int32Array(n);
  const fired = new Int32Array(n);
  const clock = new Float64Array(n);
  const pace = new Float64Array(n);
  const spent = new Uint8Array(n);
  const sigma = Float64Array.from(fleets, (f) => paceSigma(f.shots));

  const key = fleets.map((f) => `${f.team}:${f.hull}:${f.fired}:${f.shots}:${Math.round(f.pace)}`).join("|");
  const random = rng(seedFrom(`odds:${boardSize}:${key}`));

  const wins = new Array<number>(n).fill(0);
  let draws = 0;
  for (let i = 0; i < rollouts; i++) {
    const w = rollout(cells, fleets, sigma, hull, fired, clock, pace, spent, random);
    if (w >= 0) wins[w]++;
    else draws++;
  }

  return {
    teams,
    odds: wins.map((w) => w / rollouts),
    draw: draws / rollouts,
    decided: false,
    fleets,
  };
}

/**
 * The whole match's odds, sampled across the clock - the line under the number.
 *
 * Replayed from the log rather than accumulated as the match runs, so a browser source dropped
 * into a scene at the ninety-minute mark draws the same line as one that has been open all
 * evening. That is the property that matters for a stream: sources get refreshed, scenes get
 * rebuilt, and an element that can only draw what it personally watched happen is an element the
 * caster cannot trust mid-match.
 *
 * Sampled at LINE_POINTS moments rather than at every shot because the cost is one simulation per
 * point and a 200-shot match would spend seconds of the source's first paint on detail thinner
 * than the stroke. Points land on shot boundaries, since nothing moves between them.
 */
export function oddsTimeline(
  attacks: Attack[],
  teams: number[],
  shipDefs: ShipDefinition[],
  players: { team: number | null }[],
  boardSize: number,
  startedAt: string | null,
  room?: PauseFields | null,
  points = LINE_POINTS,
  rollouts = LINE_ROLLOUTS
): OddsPoint[] {
  if (!startedAt) return [];
  const startMs = new Date(startedAt).getTime();
  const windows = pauseWindows(room);

  // Distinct shot instants, oldest first - the only moments the odds can have changed.
  const instants = [
    ...new Set(
      attacks
        .filter((a) => a.cell_index >= 0)
        .map((a) => new Date(a.created_at).getTime())
    ),
  ].sort((a, b) => a - b);
  if (instants.length === 0) return [];

  const step = Math.max(1, Math.ceil(instants.length / points));
  const sampled: number[] = [];
  for (let i = 0; i < instants.length; i += step) sampled.push(instants[i]);
  // However the stride divides, the latest shot is always the last point: the end of the line is
  // where the eye goes, and it has to agree with the number printed above it.
  if (sampled[sampled.length - 1] !== instants[instants.length - 1]) {
    sampled.push(instants[instants.length - 1]);
  }

  return sampled.map((at) => {
    const fleets = fleetStates(attacks, teams, shipDefs, players, room, at);
    const snap = victoryOdds(fleets, boardSize, rollouts);
    return {
      seconds: Math.max(0, at - startMs - pausedMsBefore(windows, at)) / 1000,
      odds: snap.odds,
    };
  });
}

/** "71%" - odds as a whole percent, which is all the precision a stream can read. */
export function oddsLabel(odds: number): string {
  return `${Math.round(odds * 100)}%`;
}

/**
 * The history line's geometry: one filled band per fleet, stacked to fill the box.
 *
 * Pure, and separate from the component that draws it, because a stacking bug is invisible to
 * review and to the eye. Bands that leave a sliver of background between them, or that stack in a
 * different order than the legend beside them, look like a rendering artefact rather than a wrong
 * answer - and on a stream nobody will ever check. Here it can be asserted; see
 * scripts/check-victory-odds.ts.
 *
 * Bands are walked as a running cumulative total rather than summed per point, so neighbours share
 * an edge exactly instead of meeting at two independently rounded numbers.
 *
 * SVG's y axis runs downward, so a band's top edge is `height - cumulative * height`: fleet 0 sits
 * along the bottom of the box and the stack grows upward, which is the direction a viewer reads a
 * share as growing.
 */
export function oddsBands(
  teams: number[],
  points: OddsPoint[],
  width: number,
  height: number
): { team: number; polygon: [number, number][] }[] {
  if (points.length < 2 || width <= 0 || height <= 0) return [];

  const start = points[0].seconds;
  // A match whose sampled shots all land in one instant has no horizontal axis. Falling back to 1
  // keeps the arithmetic finite and draws a flat band, which is the truth about it.
  const span = points[points.length - 1].seconds - start || 1;
  const x = (seconds: number) => ((seconds - start) / span) * width;

  const tops = points.map((p) => {
    const cumulative: number[] = [];
    let sum = 0;
    for (let t = 0; t < teams.length; t++) {
      sum += p.odds[t] ?? 0;
      cumulative[t] = sum;
    }
    return cumulative;
  });

  return teams.map((team, t) => {
    const upper: [number, number][] = points.map((p, i) => [x(p.seconds), height - tops[i][t] * height]);
    const lower: [number, number][] = points
      .map((p, i): [number, number] => [x(p.seconds), height - (t === 0 ? 0 : tops[i][t - 1]) * height])
      .reverse();
    return { team, polygon: [...upper, ...lower] };
  });
}

/**
 * Whether a snapshot has anything honest to say yet.
 *
 * Two fleets and at least one shot between them. Before that the model has nothing to go on but the
 * fleet sizes, and a 50/50 bar drawn with total confidence at the top of a match is the single most
 * misleading thing any surface here could put on screen - the odds are worth least exactly when
 * they look most authoritative.
 *
 * Lives here rather than in the component that draws it because it is a fact about the snapshot, and
 * because every surface showing odds has to agree on the answer: the browser source and the
 * spectator rail going blank at different moments would be two different claims about whether the
 * model is ready.
 */
export function oddsWorthShowing(snapshot: OddsSnapshot | null): snapshot is OddsSnapshot {
  return snapshot !== null && !snapshot.fleets.every((f) => f.shots === 0);
}
