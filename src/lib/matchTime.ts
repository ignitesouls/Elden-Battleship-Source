import { pausedMsAt, RUNNING, type PauseFields, type PauseInfo } from "./matchPause.ts";
import type { Attack } from "../types/battleship.ts";

/**
 * Sentinel cell index for the "match started" marker row written into `attacks`.
 *
 * The match clock has to read the same start instant on every client, which means it must come
 * from the database. `rooms` has no timestamp that resets per match (created_at is the room, not
 * the match) and adding one needs DDL, so the marker rides in the attack log instead - which is
 * already the per-match event log, is already realtime-synced, and is already wiped by the reset.
 * A negative index can never collide with a real square, so it is invisible to the boards.
 *
 * Defined here rather than in rooms.ts so that the pure clock/report logic doesn't have to
 * import the Supabase client (and its browser-only env vars) just to learn a constant.
 */
export const MATCH_START_MARKER = -1;

/**
 * When the match clock started, read from the shared start marker in the attack log so every
 * player's clock agrees. Falls back to the earliest shot for matches that began before the
 * marker existed, and null if there's nothing to anchor to yet.
 */
export function matchStartedAt(attacks: Attack[]): string | null {
  const marker = attacks.find((a) => a.cell_index === MATCH_START_MARKER);
  if (marker) return marker.created_at;

  const real = attacks.filter((a) => a.cell_index >= 0);
  if (real.length === 0) return null;
  return real.reduce((earliest, a) => (a.created_at < earliest ? a.created_at : earliest), real[0].created_at);
}

/**
 * Where a single event sits on the match clock, formatted the way a log line wants it.
 *
 * One function rather than the copy each log had, because there were two of them - the battle log
 * beside the board and the one on the stream overlay - and they drifted the moment pausing arrived:
 * both went on measuring raw wall time while the clock beside them stopped, so every line logged
 * after a break was ahead of the timer above it by the length of the break.
 *
 * Reads the pause windows CLAMPED at the event (see pausedMsAt), which is what makes a kill landing
 * during a pause read as the moment the pause began rather than as time nobody played. That is the
 * same rule archive_match applies when it writes match_seconds, so a line in the live log and the
 * same line on the recap afterwards agree.
 */
export function matchTimeAt(
  startedAt: string | null,
  at: string,
  timings: MatchTimings,
  pause?: PauseFields | null
): string {
  if (!startedAt) return "--:--";
  const atMs = new Date(at).getTime();
  const elapsed = (atMs - new Date(startedAt).getTime() - pausedMsAt(pause, atMs)) / 1000;
  return formatDuration(elapsed - timings.matchBeginsAt);
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Battle opens with a countdown, not straight into fire: STARTING is a short "get ready" beat
 * (the horn plays right as it begins - see Room.tsx's status-change effect), PREPARATION is a
 * longer buffer to read the board before shots are allowed, then MATCH is the fight itself. All
 * three are time windows measured from the single start marker in the attack log.
 */
export const DEFAULT_STARTING_SECONDS = 10;
export const DEFAULT_PREPARATION_SECONDS = 4 * 60;

export interface MatchTimings {
  starting: number;
  preparation: number;
  /** Seconds from the marker until firing opens. */
  matchBeginsAt: number;
}

/**
 * Countdown lengths for a room. The columns are optional in the type because rooms created
 * before the qol_batch migration don't have them - those fall back to the original constants
 * rather than collapsing to a zero-length countdown.
 */
export function matchTimings(room?: { starting_seconds?: number; prep_seconds?: number } | null): MatchTimings {
  const starting = room?.starting_seconds ?? DEFAULT_STARTING_SECONDS;
  const preparation = room?.prep_seconds ?? DEFAULT_PREPARATION_SECONDS;
  return { starting, preparation, matchBeginsAt: starting + preparation };
}

export type BattlePhaseName = "starting" | "preparation" | "match";

export interface BattlePhaseInfo {
  phase: BattlePhaseName;
  /** Seconds left in the STARTING/PREPARATION countdown; 0 once MATCH begins. */
  countdown: number;
  /** Seconds elapsed since MATCH itself began; 0 before that. */
  matchElapsed: number;
}

/**
 * Where the clock stands, given when it started and what time it is now.
 *
 * `pause` is how a match that has been stopped stays stopped, and it does the whole job in two
 * numbers (see lib/matchPause): while the clock is frozen `frozenAtMs` stands in for now, so every
 * reading below is taken at the instant the pause began; and `pausedMs` is the stopped time already
 * behind us, which comes off the elapsed figure so the clock picks up where it left off rather than
 * jumping forward by the length of the break.
 *
 * Defaulted to RUNNING rather than made required, so a caller with no room to hand - the replay, the
 * tests - reads a match that was never stopped, which is what every match before this was.
 */
export function battlePhaseAt(
  startedAt: string | null,
  nowMs: number,
  timings: MatchTimings,
  pause: PauseInfo = RUNNING
): BattlePhaseInfo | null {
  if (!startedAt) return null;
  const at = pause.frozenAtMs ?? nowMs;
  const elapsed = (at - new Date(startedAt).getTime() - pause.pausedMs) / 1000;

  if (elapsed < timings.starting) {
    return { phase: "starting", countdown: timings.starting - elapsed, matchElapsed: 0 };
  }
  if (elapsed < timings.matchBeginsAt) {
    return { phase: "preparation", countdown: timings.matchBeginsAt - elapsed, matchElapsed: 0 };
  }
  return { phase: "match", countdown: 0, matchElapsed: elapsed - timings.matchBeginsAt };
}
