import type { PauseWindow, Room } from "../types/battleship.ts";

/**
 * Stopping the match clock.
 *
 * -- The house rule this is shaped around ----------------------------------------------------------
 *
 * A pause is CALLED, not imposed. Shots keep landing right through one, deliberately: a crew that is
 * mid-boss when the pause goes up has to be able to finish it, because under the fire-on-kill rule
 * their shot IS the kill time - there is no way to hold a corpse for five minutes and file it
 * honestly afterwards. So the room asks people to reach a stopping point and stops the CLOCK, and
 * nothing in the fire path knows a pause exists.
 *
 * -- Why this is a pure function of three columns ---------------------------------------------------
 *
 * Both countdowns are FUTURE timestamps rather than a flag plus a local timer. `pause_at` is set five
 * seconds ahead of the host's press and `resume_at` five seconds ahead of their resume, so every
 * client derives the same countdown from the same two instants and the shared server clock (see
 * lib/serverTime). Nobody has to be told when a countdown ends, which is what makes a host whose
 * browser dies mid-countdown harmless: the window still closes on schedule on every other screen,
 * and the next host write folds it into the log.
 *
 * That gives four states, in the order a pause moves through them:
 *
 *   running    no pause_at. The clock counts wall time, less whatever the log already holds.
 *   pausing    now < pause_at. The warning window - the clock is STILL RUNNING while it counts down.
 *   paused     now >= pause_at, no resume_at. The clock is frozen at pause_at.
 *   resuming   resume_at is set and hasn't arrived. Still frozen at pause_at; counting down to go.
 *
 * Once resume_at passes, this reads as `running` again with the window added to the total, whether or
 * not the host's browser has got round to writing it into `pause_log`. That write is tidying, not
 * truth - see settlePause in lib/rooms.ts.
 */

/** The warning window between the host pressing pause and the clock actually stopping. */
export const PAUSE_COUNTDOWN_SECONDS = 5;
/** The same beat on the way back in, so nobody is caught looking away when the clock restarts. */
export const RESUME_COUNTDOWN_SECONDS = 5;

export type PausePhaseName = "running" | "pausing" | "paused" | "resuming";

export interface PauseInfo {
  phase: PausePhaseName;
  /** Seconds left in the pausing/resuming countdown; 0 in the two settled states. */
  countdown: number;
  /** How long the clock has been held still in total. Subtract from elapsed match time. */
  pausedMs: number;
  /** The instant the clock is frozen at, or null while it is running. */
  frozenAtMs: number | null;
  /** True while the clock is not advancing - `paused` or `resuming`, but not the warning window. */
  stopped: boolean;
}

/** The shape this module needs off a room. Narrow, so callers can hand it a partial row. */
export type PauseFields = Pick<Room, "pause_at" | "resume_at" | "pause_log">;

export const RUNNING: PauseInfo = {
  phase: "running",
  countdown: 0,
  pausedMs: 0,
  frozenAtMs: null,
  stopped: false,
};

/**
 * The closed windows, defended against a column that isn't there and against junk inside one.
 *
 * jsonb is only as well-typed as whatever last wrote it, and this feeds the match clock - a single
 * unparseable entry must not be able to take the timer down, so anything that doesn't read as two
 * timestamps is dropped rather than thrown over.
 */
export function pauseWindows(room?: PauseFields | null): PauseWindow[] {
  const log = room?.pause_log;
  if (!Array.isArray(log)) return [];
  return log.filter(
    (w) => w && typeof w.at === "string" && typeof w.until === "string" && !Number.isNaN(Date.parse(w.at))
  );
}

/**
 * How much stopped clock had accumulated by `atMs`.
 *
 * Windows are clamped to `atMs` rather than counted whole, which is what makes a shot fired DURING a
 * pause - allowed, and the whole point of the house rule - come out stamped with the clock as it
 * stood when that pause began, instead of being credited with time that hadn't passed yet.
 *
 * Mirrors public.paused_seconds_before in the match_pause migration. The two have to agree: one
 * draws the live clock, the other writes the record the live clock is checked against.
 */
export function pausedMsBefore(windows: PauseWindow[], atMs: number): number {
  let total = 0;
  for (const w of windows) {
    const from = Date.parse(w.at);
    const until = Date.parse(w.until);
    if (Number.isNaN(from) || Number.isNaN(until)) continue;
    total += Math.max(0, Math.min(until, atMs) - from);
  }
  return total;
}

export function pauseInfoAt(room: PauseFields | null | undefined, nowMs: number): PauseInfo {
  const windows = pauseWindows(room);
  const settled = pausedMsBefore(windows, nowMs);

  const pauseAt = room?.pause_at ? Date.parse(room.pause_at) : NaN;
  if (Number.isNaN(pauseAt)) {
    return { phase: "running", countdown: 0, pausedMs: settled, frozenAtMs: null, stopped: false };
  }

  const resumeRaw = room?.resume_at ? Date.parse(room.resume_at) : NaN;
  const resumeAt = Number.isNaN(resumeRaw) ? null : resumeRaw;

  // The warning window. The clock has not stopped yet, so this is a `running` reading wearing a
  // countdown - which is exactly what the screen should show: digits still moving, and a notice.
  if (nowMs < pauseAt) {
    return {
      phase: "pausing",
      countdown: (pauseAt - nowMs) / 1000,
      pausedMs: settled,
      frozenAtMs: null,
      stopped: false,
    };
  }

  // Resumed, but nobody has written the window into the log yet. Counted here rather than waited
  // for, so the clock restarts on time on every screen even if the host's tab never comes back.
  if (resumeAt !== null && nowMs >= resumeAt) {
    return {
      phase: "running",
      countdown: 0,
      pausedMs: settled + Math.max(0, resumeAt - pauseAt),
      frozenAtMs: null,
      stopped: false,
    };
  }

  if (resumeAt !== null) {
    return {
      phase: "resuming",
      countdown: (resumeAt - nowMs) / 1000,
      pausedMs: settled,
      frozenAtMs: pauseAt,
      stopped: true,
    };
  }

  return { phase: "paused", countdown: 0, pausedMs: settled, frozenAtMs: pauseAt, stopped: true };
}

/**
 * Total stopped clock before `atMs`, counting a pause that is still open.
 *
 * The difference from pausedMsBefore, and the reason both exist: that one reads the LOG, which only
 * holds windows the host has closed. An event during a pause still in progress - a kill landing in
 * the middle of one, which the house rule expressly allows - would be measured against a log that
 * does not yet mention the pause it happened inside, and come out late by however long the room had
 * been stopped.
 *
 * This is what anything stamping an EVENT wants. The clock itself does not use it: pauseInfoAt
 * already handles the open window by freezing the instant it reads at, which is a different and
 * cheaper trick that only works when the thing being measured is "now".
 */
export function pausedMsAt(room: PauseFields | null | undefined, atMs: number): number {
  let total = pausedMsBefore(pauseWindows(room), atMs);

  const from = room?.pause_at ? Date.parse(room.pause_at) : NaN;
  if (Number.isNaN(from) || atMs <= from) return total;

  const scheduled = room?.resume_at ? Date.parse(room.resume_at) : NaN;
  const until = Number.isNaN(scheduled) ? atMs : Math.min(scheduled, atMs);
  total += Math.max(0, until - from);

  return total;
}

/**
 * The stretch of clock that has ALREADY been stopped and is owed to the log, or null if none is.
 *
 * Clamped at `nowMs` rather than trusting resume_at, because this is also what a host pressing pause
 * on top of an unfinished window has to bank before overwriting pause_at - and in that case the
 * scheduled resume never happened, so the window ends now. A warning window that hasn't reached
 * pause_at yet returns null: the clock never actually stopped, so there is nothing to record.
 */
export function closedWindow(room: PauseFields | null | undefined, nowMs: number): PauseWindow | null {
  if (!room?.pause_at) return null;
  const from = Date.parse(room.pause_at);
  if (Number.isNaN(from) || nowMs < from) return null;

  const scheduled = room.resume_at ? Date.parse(room.resume_at) : NaN;
  const until = Number.isNaN(scheduled) ? nowMs : Math.min(scheduled, nowMs);
  if (until <= from) return null;

  return { at: new Date(from).toISOString(), until: new Date(until).toISOString() };
}

/** Whether anybody still needs to press "Ready" before the host can sensibly resume. */
export function readyToResume(crew: { pause_ready?: boolean }[]): boolean {
  return crew.length > 0 && crew.every((p) => p.pause_ready === true);
}
