import { participantKey } from "./careerStats";
import { archivedShots, MIN_GAP_SECONDS } from "./recordBook";
import type { ShipPlacement, ShipDefinition } from "../types/battleship";

export interface MatchFleetRow {
  match_key: string;
  team: number;
  board_size: number;
  placements: ShipPlacement[];
  ship_defs: ShipDefinition[];
  room_id?: string | null;
  finished_at: string;
  square_set?: string | null;
}

export interface MatchEventRow {
  match_key: string;
  user_id: string | null;
  nickname: string;
  team: number;
  cell_index: number;
  challenge_name: string | null;
  result: string;
  match_seconds: number | null;
  board_size: number;
  room_id?: string | null;
  finished_at: string;
  square_set?: string | null;
  /** Seed the board was dealt from; needed to rebuild it after the room is pruned. */
  board_seed?: string | null;
  /** How the balancer rearranged that deal, if it did. Null for every unbalanced match. */
  board_perm?: number[] | null;
}

/** Minimal shape of a participant row, for the cross-table stats below. */
export interface ParticipantLite {
  match_key: string;
  nickname: string;
  team: number;
  won: boolean;
  draw: boolean;
  team_ships_lost: number;
  square_set?: string | null;
}

export interface Heatmap {
  boardSize: number;
  /** Raw count per cell index. */
  counts: number[];
  max: number;
  total: number;
  /** Fleets (or shots) that fed this map, for "n = ..." labelling. */
  samples: number;
}

/**
 * How often each cell has held a ship.
 *
 * Scoped to a single board size because an 8x8 and a 12x12 don't share a coordinate space -
 * merging them would smear two different geometries into one meaningless average.
 */
export function placementHeatmap(fleets: MatchFleetRow[], boardSize: number): Heatmap {
  const counts = new Array(boardSize * boardSize).fill(0);
  let samples = 0;
  let total = 0;

  for (const f of fleets) {
    if (f.board_size !== boardSize) continue;
    samples++;
    for (const p of f.placements ?? []) {
      const size = f.ship_defs?.[p.shipIndex]?.size ?? 0;
      for (let i = 0; i < size; i++) {
        const r = p.startRow + (p.isHorizontal ? 0 : i);
        const c = p.startCol + (p.isHorizontal ? i : 0);
        if (r < 0 || r >= boardSize || c < 0 || c >= boardSize) continue;
        counts[r * boardSize + c]++;
        total++;
      }
    }
  }

  return { boardSize, counts, max: Math.max(0, ...counts), total, samples };
}

/** Where people actually shoot, as opposed to where ships actually are. */
export function shotHeatmap(events: MatchEventRow[], boardSize: number): Heatmap {
  const counts = new Array(boardSize * boardSize).fill(0);
  let total = 0;
  const matches = new Set<string>();

  for (const e of events) {
    if (e.board_size !== boardSize) continue;
    if (e.cell_index < 0 || e.cell_index >= counts.length) continue;
    counts[e.cell_index]++;
    total++;
    matches.add(e.match_key);
  }

  return { boardSize, counts, max: Math.max(0, ...counts), total, samples: matches.size };
}

export interface BossStat {
  name: string;
  /** Times this boss has been shot at. */
  attempts: number;
  hits: number;
  sunk: number;
  hitRate: number;
  /** Median, not mean - one player who wandered off mid-match shouldn't define "typical". */
  medianSeconds: number | null;
  /** Shots the median is built from: attempts minus any that arrived without a usable clock. */
  timed: number;
  fastest: { seconds: number; nickname: string } | null;
  slowest: { seconds: number; nickname: string } | null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Per-boss timing and success rates across every recorded match.
 *
 * Timings count EVERY shot, hit or miss. A shot is fired by beating the boss on that square, and
 * that fight takes exactly as long whether or not an enemy ship turned out to be hiding under it -
 * hit and miss describe the opponent's placement, not the player's run. Counting only hits would
 * throw away most of the sample and bias what's left toward whichever bosses sat on ships.
 */
export function bossStats(events: MatchEventRow[]): BossStat[] {
  const byName = new Map<string, { attempts: number; hits: number; sunk: number; times: { s: number; who: string }[] }>();

  for (const e of events) {
    const name = e.challenge_name;
    if (!name) continue;
    let b = byName.get(name);
    if (!b) {
      b = { attempts: 0, hits: 0, sunk: 0, times: [] };
      byName.set(name, b);
    }
    b.attempts++;
    if (e.result === "hit" || e.result === "sunk") b.hits++;
    if (e.result === "sunk") b.sunk++;
    if (e.match_seconds !== null && e.match_seconds >= 0) {
      b.times.push({ s: e.match_seconds, who: e.nickname });
    }
  }

  const out: BossStat[] = [];
  for (const [name, b] of byName) {
    const sorted = [...b.times].sort((x, y) => x.s - y.s);
    out.push({
      name,
      attempts: b.attempts,
      hits: b.hits,
      sunk: b.sunk,
      hitRate: b.attempts > 0 ? b.hits / b.attempts : 0,
      medianSeconds: median(b.times.map((t) => t.s)),
      timed: b.times.length,
      fastest: sorted.length ? { seconds: sorted[0].s, nickname: sorted[0].who } : null,
      slowest: sorted.length ? { seconds: sorted[sorted.length - 1].s, nickname: sorted[sorted.length - 1].who } : null,
    });
  }

  return out.sort((a, b) => b.attempts - a.attempts || a.name.localeCompare(b.name));
}

/** One square with the fight behind it timed - see {@link timedSquares}. */
export interface QuickSquareRecord {
  key: string;
  nickname: string;
  challenge: string | null;
  /** How long the fight took, NOT when it landed. */
  seconds: number;
  matchKey: string;
  finishedAt: string;
  /** Kept so the board can mark the ones that also found a ship. */
  result: string;
  /** The square before it, which is what this one was timed from. */
  previous: string | null;
}

/**
 * Every square whose fight can be timed, with how long that fight took.
 *
 * `match_seconds` is WHEN a square fell, not how long it took to take. Under the fire-on-kill rule
 * the fight is the gap back to that captain's previous shot - which is what squarePace has always
 * measured, and what the boards below now rank on. Ranking on `match_seconds` instead ranks by how
 * early somebody fired, so only opening shots could ever place: the Almanac board read 0:04 to 0:34
 * against a median square of about two and a half minutes, because it was really a list of who got
 * their first square in quickest.
 *
 * The two exclusions are squarePace's, for squarePace's reasons:
 *
 *   - an opening shot has nothing to be measured back from. The clock before it is the lobby, the
 *     placement phase, and whatever fight the captain was already in when firing opened - not work
 *     on that square. Opening squares have their own record, "Quickest first blood".
 *   - a gap under MIN_GAP_SECONDS is one duo fight filling two squares, or a banked kill fired next
 *     to the following one. Neither is a fast square, and either would sit at the top forever.
 *
 * Built on archivedShots so a three-team match counts each trigger-pull once: the archive writes one
 * row per opposing fleet, and gaps taken off raw rows would be a string of zeroes.
 */
function timedSquares(events: MatchEventRow[]): QuickSquareRecord[] {
  const out: QuickSquareRecord[] = [];
  // archivedShots sorts by match, then by time - exactly the order a gap is measured in.
  const previous = new Map<string, { seconds: number; challenge: string | null }>();

  for (const shot of archivedShots(events)) {
    const run = `${shot.matchKey}|${shot.key}`;
    const before = previous.get(run);
    previous.set(run, { seconds: shot.seconds, challenge: shot.challenge });
    if (before === undefined) continue;

    const gap = shot.seconds - before.seconds;
    if (gap < MIN_GAP_SECONDS) continue;
    out.push({
      key: shot.key,
      nickname: shot.nickname,
      challenge: shot.challenge,
      seconds: gap,
      matchKey: shot.matchKey,
      finishedAt: shot.finishedAt,
      result: shot.result,
      previous: before.challenge,
    });
  }

  return out;
}

/**
 * The quickest squares on record, hit or miss.
 *
 * Same reasoning as {@link bossStats} on hit versus miss: the clock measures the fight, and whether
 * a ship was under the square is the opponent's doing, not the runner's. A miss belongs here.
 */
export function fastestKills(events: MatchEventRow[], limit = 10): QuickSquareRecord[] {
  return timedSquares(events)
    .sort((a, b) => a.seconds - b.seconds)
    .slice(0, limit);
}

/** Shots in a match, oldest first. Ordering is by elapsed time, which is what every pace stat needs. */
function shotsInOrder(events: MatchEventRow[]): MatchEventRow[] {
  return [...events]
    .filter((e) => e.match_seconds !== null)
    .sort((a, b) => (a.match_seconds as number) - (b.match_seconds as number));
}

/** Exported as groupEventsByMatch for the Almanac page, which needs the same grouping to split sets. */
export function groupEventsByMatch(events: MatchEventRow[]): Map<string, MatchEventRow[]> {
  return groupByMatch(events);
}

function groupByMatch(events: MatchEventRow[]): Map<string, MatchEventRow[]> {
  const m = new Map<string, MatchEventRow[]>();
  for (const e of events) {
    const l = m.get(e.match_key);
    if (l) l.push(e);
    else m.set(e.match_key, [e]);
  }
  return m;
}

export interface PlayerPace {
  /** Same grouping key careers use, so an account keeps one pace across nickname changes. */
  key: string;
  nickname: string;
  shots: number;
  matches: number;
  /** Mean seconds between that player's own consecutive shots. Lower is faster. */
  secondsPerShot: number;
  /** Their single best match, by the same measure. */
  bestMatch: { seconds: number; matchKey: string } | null;
}

/**
 * How fast each player works through the board.
 *
 * Measured as elapsed time divided by shots WITHIN each match, then pooled - not as wall-clock
 * across their whole career, which would count the days between sessions as thinking time.
 * Matches with a single shot are skipped: one shot has no interval to measure.
 */
export function playerPace(events: MatchEventRow[]): PlayerPace[] {
  const byPlayer = new Map<
    string,
    { nickname: string; shots: number; matches: Set<string>; spans: { s: number; key: string }[] }
  >();

  for (const [matchKey, evs] of groupByMatch(events)) {
    const byKey = new Map<string, MatchEventRow[]>();
    for (const e of evs) {
      const k = participantKey(e);
      const l = byKey.get(k);
      if (l) l.push(e);
      else byKey.set(k, [e]);
    }

    for (const [key, own] of byKey) {
      const ordered = shotsInOrder(own);
      let p = byPlayer.get(key);
      if (!p) {
        p = { nickname: own[0].nickname, shots: 0, matches: new Set(), spans: [] };
        byPlayer.set(key, p);
      }
      p.nickname = own[0].nickname;
      p.shots += own.length;
      p.matches.add(matchKey);

      if (ordered.length >= 2) {
        const first = ordered[0].match_seconds as number;
        const last = ordered[ordered.length - 1].match_seconds as number;
        p.spans.push({ s: (last - first) / (ordered.length - 1), key: matchKey });
      }
    }
  }

  const out: PlayerPace[] = [];
  for (const [key, p] of byPlayer) {
    if (p.spans.length === 0) continue;
    const mean = p.spans.reduce((n, x) => n + x.s, 0) / p.spans.length;
    const best = [...p.spans].sort((a, b) => a.s - b.s)[0];
    out.push({
      key,
      nickname: p.nickname,
      shots: p.shots,
      matches: p.matches.size,
      secondsPerShot: mean,
      bestMatch: { seconds: best.s, matchKey: best.key },
    });
  }
  return out.sort((a, b) => a.secondsPerShot - b.secondsPerShot);
}

export interface PlayerKill {
  challenge: string | null;
  seconds: number;
  result: string;
  matchKey: string;
  finishedAt: string;
}

/** Every square this player took, newest match first. The per-player attribution log. */
export function playerKills(events: MatchEventRow[], key: string): PlayerKill[] {
  return events
    .filter((e) => participantKey(e) === key && e.match_seconds !== null)
    .map((e) => ({
      challenge: e.challenge_name,
      seconds: e.match_seconds as number,
      result: e.result,
      matchKey: e.match_key,
      finishedAt: e.finished_at,
    }))
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || a.seconds - b.seconds);
}

/**
 * This player's quickest squares, hit or miss - their personal record board.
 *
 * Timed as fights, per {@link timedSquares}, not as positions on the match clock. The log above is
 * the other way round on purpose: a log is a record of when things happened.
 */
export function playerBestKills(events: MatchEventRow[], key: string, limit = 5): QuickSquareRecord[] {
  return timedSquares(events)
    .filter((s) => s.key === key)
    .sort((a, b) => a.seconds - b.seconds)
    .slice(0, limit);
}

export interface BossFrequency {
  name: string;
  /** Boards this boss appeared on. */
  appeared: number;
  /** Boards where somebody actually shot at it. */
  fired: number;
  /** Times it was the very first shot of a match. */
  opened: number;
  missRate: number;
}

/**
 * Which bosses get ignored, and which get rushed first.
 *
 * `resolveBoard` reconstructs the full challenge list for a match from its room id, which is the
 * only way to see bosses that were never touched - match_events by definition only records
 * shots that happened, so a boss nobody fired at leaves no trace in it at all.
 *
 * It also gets the squares that WERE fired at, with their cell numbers. Rooms can now be played on
 * different square sets and the room row is long gone by the time this runs, so those pairs are the
 * only evidence of which set a match used: rebuild the board with each, and the right one puts the
 * recorded names in the recorded places. Returning [] tells us it couldn't be identified.
 */
export function bossFrequency(
  events: MatchEventRow[],
  resolveBoard: (
    roomId: string,
    cells: number,
    fired: Array<{ cell: number; name: string }>,
    seed: string | null,
    perm: number[] | null
  ) => string[]
): BossFrequency[] {
  const stats = new Map<string, BossFrequency>();
  const touch = (name: string): BossFrequency => {
    let b = stats.get(name);
    if (!b) {
      b = { name, appeared: 0, fired: 0, opened: 0, missRate: 0 };
      stats.set(name, b);
    }
    return b;
  };

  for (const evs of groupByMatch(events).values()) {
    const roomId = evs.find((e) => e.room_id)?.room_id;
    const boardSize = evs[0].board_size;
    const firedNames = new Set(evs.map((e) => e.challenge_name).filter(Boolean) as string[]);

    // Without a room id - or without a square set we can identify from it - we can't know what
    // else was on the board, so only count what was fired at: better a smaller sample than a
    // fabricated denominator.
    const fired = evs
      .filter((e) => e.challenge_name && e.cell_index >= 0)
      .map((e) => ({ cell: e.cell_index, name: e.challenge_name as string }));
    // Per MATCH, not per room: a room that played three matches dealt three different boards
    // from three different seeds, so the seed has to come off these rows rather than the room.
    const seed = evs.find((e) => e.board_seed)?.board_seed ?? null
    // Per match for the same reason, and from the same rows: a balanced board was rearranged after
    // the fleets went down, so the seed alone no longer says where anything ended up.
    const perm = evs.find((e) => e.board_perm)?.board_perm ?? null
    const rebuilt = roomId ? resolveBoard(roomId, boardSize * boardSize, fired, seed, perm) : [];
    const allNames = rebuilt.length > 0 ? rebuilt : [...firedNames];
    for (const n of allNames) touch(n).appeared++;
    for (const n of firedNames) touch(n).fired++;

    const opener = shotsInOrder(evs)[0];
    if (opener?.challenge_name) touch(opener.challenge_name).opened++;
  }

  const out = [...stats.values()];
  for (const b of out) b.missRate = b.appeared > 0 ? 1 - b.fired / b.appeared : 0;
  return out;
}

export interface MatchShape {
  matches: number;
  /** Mean number of times the next shot came from a different team than the one before it. */
  avgBackAndForth: number;
  /** Share of matches won by whoever landed the first hit. */
  firstBloodWinRate: number;
  firstBloodSample: number;
  /** Wins without losing a single ship. */
  flawlessWins: number;
  /** Share of all board squares that ever got fired at. */
  boardCoverage: number;
  busiest: { matchKey: string; changes: number } | null;
}

/**
 * Whole-match character: how much the initiative traded hands, whether drawing first blood
 * actually predicts winning, and how much of the board typically gets touched.
 */
export function matchShape(events: MatchEventRow[], participants: ParticipantLite[]): MatchShape {
  const byKey = groupByMatch(events);
  const partsByMatch = new Map<string, ParticipantLite[]>();
  for (const p of participants) {
    const l = partsByMatch.get(p.match_key);
    if (l) l.push(p);
    else partsByMatch.set(p.match_key, [p]);
  }

  let changesTotal = 0;
  let firstBloodWins = 0;
  let firstBloodSample = 0;
  let coverageHit = 0;
  let coverageTotal = 0;
  let busiest: { matchKey: string; changes: number } | null = null;

  for (const [key, evs] of byKey) {
    const ordered = shotsInOrder(evs);

    let changes = 0;
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].team !== ordered[i - 1].team) changes++;
    }
    changesTotal += changes;
    if (!busiest || changes > busiest.changes) busiest = { matchKey: key, changes };

    const firstHit = ordered.find((e) => e.result === "hit" || e.result === "sunk");
    const parts = partsByMatch.get(key);
    if (firstHit && parts?.length) {
      const shooter = parts.find((p) => p.team === firstHit.team);
      if (shooter && !shooter.draw) {
        firstBloodSample++;
        if (shooter.won) firstBloodWins++;
      }
    }

    coverageHit += new Set(evs.map((e) => e.cell_index)).size;
    coverageTotal += evs[0].board_size * evs[0].board_size;
  }

  const flawlessWins = participants.filter((p) => p.won && p.team_ships_lost === 0).length;

  return {
    matches: byKey.size,
    avgBackAndForth: byKey.size > 0 ? changesTotal / byKey.size : 0,
    firstBloodWinRate: firstBloodSample > 0 ? firstBloodWins / firstBloodSample : 0,
    firstBloodSample,
    flawlessWins,
    boardCoverage: coverageTotal > 0 ? coverageHit / coverageTotal : 0,
    busiest,
  };
}

/** Board sizes present in the data, so the UI only offers maps it can actually draw. */
export function boardSizesPresent(fleets: MatchFleetRow[], events: MatchEventRow[]): number[] {
  const s = new Set<number>();
  for (const f of fleets) s.add(f.board_size);
  for (const e of events) s.add(e.board_size);
  return [...s].sort((a, b) => a - b);
}

/** One square with everything the almanac knows about it - see {@link mergeSquareStats}. */
export interface SquareRow {
  name: string;
  /** Times it has been shot at. Zero for a square nobody has ever taken. */
  attempts: number;
  hits: number;
  sunk: number;
  /** Null rather than 0 when it has never been fired at: no attempts is not a 0% hit rate. */
  hitRate: number | null;
  medianSeconds: number | null;
  timed: number;
  fastest: { seconds: number; nickname: string } | null;
  /** Boards it appeared on, including the ones where it was left alone. */
  appeared: number;
  /** Boards where somebody actually shot at it. */
  fired: number;
  opened: number;
  missRate: number;
}

/**
 * Shooting stats and board frequency for every square, in one row each.
 *
 * Built from the union of the two, not from {@link bossStats} alone. bossStats is assembled out of
 * match_events, which by definition only records shots that happened - so the squares that are most
 * worth reading about, the ones nobody has ever fired at, are exactly the ones missing from it.
 * {@link bossFrequency} rebuilds the whole board and is the only side that has them.
 */
export function mergeSquareStats(stats: BossStat[], freq: BossFrequency[]): SquareRow[] {
  const rows = new Map<string, SquareRow>();
  const touch = (name: string): SquareRow => {
    let r = rows.get(name);
    if (!r) {
      r = {
        name,
        attempts: 0,
        hits: 0,
        sunk: 0,
        hitRate: null,
        medianSeconds: null,
        timed: 0,
        fastest: null,
        appeared: 0,
        fired: 0,
        opened: 0,
        missRate: 0,
      };
      rows.set(name, r);
    }
    return r;
  };

  for (const f of freq) {
    const r = touch(f.name);
    r.appeared = f.appeared;
    r.fired = f.fired;
    r.opened = f.opened;
    r.missRate = f.missRate;
  }

  for (const s of stats) {
    const r = touch(s.name);
    r.attempts = s.attempts;
    r.hits = s.hits;
    r.sunk = s.sunk;
    r.hitRate = s.attempts > 0 ? s.hitRate : null;
    r.medianSeconds = s.medianSeconds;
    r.timed = s.timed;
    r.fastest = s.fastest;
  }

  return [...rows.values()];
}
