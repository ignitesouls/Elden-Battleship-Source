/**
 * Rebuilding a finished match as a sequence of states, so it can be played back shot by shot.
 *
 * Nothing new is stored for this. `match_fleets` already holds where every hull sat and
 * `match_events` already holds every trigger-pull with the elapsed second it happened at, which
 * between them is the whole match: fold the shots over the placements and every intermediate board
 * falls out. The room those rows came from was pruned within the hour, so this is the only way any
 * of it can be seen again.
 *
 * It is also MORE accurate than reading the archived `result` column, which is why the outcomes
 * here are recomputed rather than trusted. archive_match collapses a shot across every defender
 * (`bool_or(hit or sunk)`), so in a three-fleet match a shot that struck one fleet and missed
 * another survives only as "hit" and reads as a hit on both boards. Placements let each defender be
 * resolved separately, which is exact. Matches archived without placements fall back to the
 * collapsed column, and say so through `exact`.
 */
import type { ShipDefinition, ShipPlacement } from "../types/battleship";

export type Outcome = "hit" | "miss" | "sunk";

export interface ReplayFleetInput {
  team: number;
  board_size: number;
  placements: ShipPlacement[] | null;
  ship_defs: ShipDefinition[] | null;
}

export interface ReplayEventInput {
  nickname: string;
  team: number;
  cell_index: number;
  challenge_name: string | null;
  result: string;
  match_seconds: number | null;
  board_size: number;
}

/** One hull: where it was placed, and the cells that puts it on. */
export interface ReplayShip {
  team: number;
  name: string;
  size: number;
  /** Kept alongside `cells` because a hull that runs off the board loses cells but still starts
   *  where it starts - deriving the origin back out of a truncated cell list would misplace it. */
  startRow: number;
  startCol: number;
  horizontal: boolean;
  cells: number[];
}

export interface ReplayShot {
  /** Position in the timeline, 0-based. */
  index: number;
  /** The team that fired. */
  team: number;
  nickname: string;
  cellIndex: number;
  challengeName: string | null;
  /** Seconds after firing opened. Null on rows archived before shots were timed. */
  seconds: number | null;
  /** What this shot did to each defending fleet, resolved separately per defender. */
  outcomes: Array<{ team: number; result: Outcome }>;
  /** Hulls this shot finished off. Drives the timeline markers and the log's SANK lines. */
  sank: Array<{ team: number; ship: string }>;
}

export interface Replay {
  boardSize: number;
  /** Teams with a board to draw, lowest first. */
  teams: number[];
  ships: ReplayShip[];
  shots: ReplayShot[];
  /**
   * True when every fleet's placements were archived, so per-defender outcomes are exact. False
   * means at least one board is drawn from the collapsed result column and may overstate hits.
   */
  exact: boolean;
}

/** A single fleet's condition at one point in the match. */
export interface TeamState {
  team: number;
  /** Cell -> what the shot fired at it did to THIS fleet. */
  cells: Map<number, Outcome>;
  /** Cell -> hull orientation, so sunk markers can rotate to match the ship under them. */
  sunkOrientation: Map<number, boolean>;
  shipsTotal: number;
  shipsSunk: number;
  hullTotal: number;
  /** Distinct hull cells struck - counted per cell, not per shot, so two players firing at the
   *  same square can't push it past hullTotal. */
  hullHit: number;
  /** Share of this fleet destroyed - which is the opposing side's progress toward winning. */
  destroyed: number;
  /** Every hull gone. In a two-fleet match this is the moment the other side won. */
  eliminated: boolean;
}

export interface ShooterState {
  nickname: string;
  team: number;
  shots: number;
  hits: number;
  sunk: number;
}

export interface ReplayState {
  /** Shots played so far: 0 is the opening board, shots.length is the final one. */
  cursor: number;
  /** Match clock at the cursor, or null before the first shot / on untimed matches. */
  seconds: number | null;
  teams: TeamState[];
  shooters: ShooterState[];
  lastShot: ReplayShot | null;
}

/**
 * Shots in the order they were fired.
 *
 * `match_seconds` is whole seconds, so shots inside the same second need a tiebreak or the replay
 * would shuffle itself between renders. Team, then nickname, then cell is arbitrary but stable,
 * which is the property that matters. Untimed rows sort last: they carry no position at all, and
 * putting them at the front would rewrite the opening of every old match.
 */
function inOrder(events: ReplayEventInput[]): ReplayEventInput[] {
  return [...events].sort((a, b) => {
    const as = a.match_seconds;
    const bs = b.match_seconds;
    if (as === null || bs === null) {
      if (as !== bs) return as === null ? 1 : -1;
    } else if (as !== bs) {
      return as - bs;
    }
    return a.team - b.team || a.nickname.localeCompare(b.nickname) || a.cell_index - b.cell_index;
  });
}

/** Expands one placement into its cells, dropping any that run off the board. */
function hullCells(p: ShipPlacement, size: number, boardSize: number): number[] {
  const cells: number[] = [];
  for (let n = 0; n < size; n++) {
    const row = p.isHorizontal ? p.startRow : p.startRow + n;
    const col = p.isHorizontal ? p.startCol + n : p.startCol;
    // Per axis, before flattening: a single index check would let a hull running off the right
    // edge wrap onto the start of the next row.
    if (row < 0 || col < 0 || row >= boardSize || col >= boardSize) continue;
    cells.push(row * boardSize + col);
  }
  return cells;
}

/**
 * Turns the archive rows for one match into a replay.
 *
 * Returns null when there is nothing to play - no shots, or no board size to draw them on.
 */
export function buildReplay(fleets: ReplayFleetInput[], events: ReplayEventInput[]): Replay | null {
  const boardSize = fleets[0]?.board_size ?? events[0]?.board_size ?? 0;
  if (boardSize <= 0 || events.length === 0) return null;

  const placed = fleets.filter((f) => (f.placements ?? []).length > 0);
  const ships: ReplayShip[] = [];
  /** Per team, the hull each of its cells belongs to - the lookup every shot needs. */
  const shipAt = new Map<number, Map<number, ReplayShip>>();

  for (const f of placed) {
    const defs = f.ship_defs ?? [];
    const byCell = new Map<number, ReplayShip>();
    for (const p of f.placements ?? []) {
      const def = defs[p.shipIndex];
      if (!def) continue;
      const ship: ReplayShip = {
        team: f.team,
        name: def.name,
        size: def.size,
        startRow: p.startRow,
        startCol: p.startCol,
        horizontal: p.isHorizontal,
        cells: hullCells(p, def.size, boardSize),
      };
      ships.push(ship);
      for (const c of ship.cells) byCell.set(c, ship);
    }
    shipAt.set(f.team, byCell);
  }

  // Boards worth drawing: anyone who placed a fleet, plus anyone who only ever appears as a
  // shooter (an old match with no archived placements still has two sides to show).
  const teams = new Set<number>();
  for (const f of placed) teams.add(f.team);
  for (const e of events) teams.add(e.team);

  // Resolution is causal - whether a shot sinks a hull depends on which of that hull's cells were
  // already struck - so it happens once, here, and the state fold below just replays the answers.
  const struck = new Map<number, Set<number>>(); // defender team -> cells of theirs already hit
  const sunkShips = new Set<ReplayShip>();
  const shots: ReplayShot[] = [];

  for (const [index, e] of inOrder(events).entries()) {
    const outcomes: ReplayShot["outcomes"] = [];
    const sank: ReplayShot["sank"] = [];

    for (const team of teams) {
      if (team === e.team) continue; // nobody fires at their own board
      const byCell = shipAt.get(team);
      if (!byCell) {
        // No placements archived for this defender: the collapsed column is all there is.
        const r = e.result === "sunk" ? "sunk" : e.result === "hit" ? "hit" : "miss";
        outcomes.push({ team, result: r });
        continue;
      }

      const ship = byCell.get(e.cell_index);
      if (!ship) {
        outcomes.push({ team, result: "miss" });
        continue;
      }

      let hits = struck.get(team);
      if (!hits) {
        hits = new Set();
        struck.set(team, hits);
      }
      hits.add(e.cell_index);

      // A hull with every cell struck goes down - once. Two players can each fire at the same
      // cell (the unique constraint is per nickname), and the second shot must not re-sink it.
      if (!sunkShips.has(ship) && ship.cells.every((c) => hits.has(c))) {
        sunkShips.add(ship);
        sank.push({ team, ship: ship.name });
        outcomes.push({ team, result: "sunk" });
      } else {
        outcomes.push({ team, result: "hit" });
      }
    }

    shots.push({
      index,
      team: e.team,
      nickname: e.nickname,
      cellIndex: e.cell_index,
      challengeName: e.challenge_name,
      seconds: e.match_seconds,
      outcomes,
      sank,
    });
  }

  return {
    boardSize,
    teams: [...teams].sort((a, b) => a - b),
    ships,
    shots,
    // Every side that took part must have placements, or some board here is guesswork.
    exact: teams.size > 0 && [...teams].every((t) => shipAt.has(t)),
  };
}

/**
 * The match as it stood after `cursor` shots.
 *
 * Folded from the start each time rather than kept as a mutable cursor, so scrubbing backwards
 * costs exactly what scrubbing forwards does and there is no state to get out of step. A match is
 * a few hundred shots, so the whole fold is cheaper than the render it feeds.
 */
export function replayStateAt(replay: Replay, cursor: number): ReplayState {
  const at = Math.max(0, Math.min(cursor, replay.shots.length));

  const teams = new Map<number, TeamState>();
  for (const team of replay.teams) {
    const own = replay.ships.filter((s) => s.team === team);
    teams.set(team, {
      team,
      cells: new Map(),
      sunkOrientation: new Map(),
      shipsTotal: own.length,
      shipsSunk: 0,
      hullTotal: own.reduce((n, s) => n + s.cells.length, 0),
      hullHit: 0,
      destroyed: 0,
      eliminated: false,
    });
  }

  const shooters = new Map<string, ShooterState>();

  for (let i = 0; i < at; i++) {
    const shot = replay.shots[i];

    let who = shooters.get(shot.nickname);
    if (!who) {
      who = { nickname: shot.nickname, team: shot.team, shots: 0, hits: 0, sunk: 0 };
      shooters.set(shot.nickname, who);
    }
    who.shots++;
    // Counted once per shot however many fleets it struck, so accuracy stays a share of shots
    // fired and can never exceed 100%.
    if (shot.outcomes.some((o) => o.result !== "miss")) who.hits++;
    who.sunk += shot.sank.length;

    for (const o of shot.outcomes) {
      const state = teams.get(o.team);
      if (!state) continue;
      const prior = state.cells.get(shot.cellIndex);
      // Keep the strongest outcome a cell has ever shown: a later miss by someone else must not
      // downgrade a hull square that is already burning.
      if (!(prior === "sunk" || (prior === "hit" && o.result === "miss"))) {
        state.cells.set(shot.cellIndex, o.result);
      }
    }

    for (const s of shot.sank) {
      const state = teams.get(s.team);
      if (!state) continue;
      state.shipsSunk++;
      // Mark the whole hull sunk, not just the cell that finished it, and record its orientation
      // for the marker art.
      const ship = replay.ships.find((x) => x.team === s.team && x.name === s.ship);
      if (ship) {
        for (const c of ship.cells) {
          state.cells.set(c, "sunk");
          state.sunkOrientation.set(c, ship.horizontal);
        }
      }
    }
  }

  for (const state of teams.values()) {
    // Read off the board rather than tallied during the fold: the same cell can be fired at by two
    // different players, and counting those separately would report more hull damage than the fleet
    // has hull.
    let hullHit = 0;
    for (const outcome of state.cells.values()) if (outcome !== "miss") hullHit++;
    state.hullHit = Math.min(hullHit, state.hullTotal || hullHit);
    state.destroyed = state.hullTotal > 0 ? state.hullHit / state.hullTotal : 0;
    state.eliminated = state.shipsTotal > 0 && state.shipsSunk >= state.shipsTotal;
  }

  const lastShot = at > 0 ? replay.shots[at - 1] : null;

  return {
    cursor: at,
    seconds: lastShot?.seconds ?? null,
    teams: [...teams.values()],
    shooters: [...shooters.values()].sort((a, b) => a.team - b.team || b.hits - a.hits),
    lastShot,
  };
}

/** The last timed shot, for labelling the end of the scrubber. */
export function replayDuration(replay: Replay): number | null {
  for (let i = replay.shots.length - 1; i >= 0; i--) {
    const s = replay.shots[i].seconds;
    if (s !== null) return s;
  }
  return null;
}
