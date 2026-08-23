import { useCallback, useSyncExternalStore } from "react";
import {
  matchStartedAt,
  battlePhaseAt,
  matchTimings,
  type BattlePhaseInfo,
  type BattlePhaseName,
} from "../lib/matchTime";
import { pauseInfoAt, type PauseInfo } from "../lib/matchPause";
import { serverNow, syncServerClock } from "../lib/serverTime";
import type { Attack, Room } from "../types/battleship";

/** How often to re-check the offset. Covers an NTP correction landing mid-match. */
const RESYNC_MS = 5 * 60 * 1000;

/**
 * ONE tick for the whole tab, and two hooks reading it at different resolutions.
 *
 * -- Why this isn't a per-component setInterval any more -------------------------------------------
 *
 * It used to be. Every caller ran its own 1s interval holding its own `now` in its own useState, and
 * the match screen mounts four of them (the room page, the battle phase, the clock, and a stream
 * overlay if one is open). That is four timers for one number - but the timers were never the
 * expensive part. The expensive part was WHERE they lived: the room page's copy sits at the very top
 * of the tree, so a state update in it re-rendered the entire match screen - both 100-cell boards,
 * every marker, the log, the rosters - once per second, forever, for a clock that most of that tree
 * does not draw.
 *
 * -- The split -------------------------------------------------------------------------------------
 *
 * Almost nothing needs the seconds. The room page and the battle phase each read exactly one thing
 * out of this - which of STARTING/PREPARATION/MATCH we are in - and that changes twice a match.
 * So `useBattlePhaseName` subscribes to the same tick but hands React a STRING as its snapshot:
 * React compares it, sees "match" === "match", and skips the render entirely. Those two components
 * now re-render on a phase change and on real game events, and not otherwise.
 *
 * `useBattleClock` is the one that still ticks, and it is only ever called by something small that
 * is actually drawing digits.
 */
let now = serverNow();
const listeners = new Set<() => void>();
let tick: ReturnType<typeof setInterval> | null = null;
let resync: ReturnType<typeof setInterval> | null = null;

function notify() {
  for (const listener of listeners) listener();
}

/**
 * Subscribes to the shared tick, starting it if this is the first listener.
 *
 * `now` is refreshed here rather than only in the interval: the module-level initialiser runs at
 * import time, which can be long before anyone subscribes, and useSyncExternalStore re-reads the
 * snapshot immediately after subscribing - so a stale reading is corrected on the same frame rather
 * than a second later.
 */
function subscribe(fn: () => void): () => void {
  now = serverNow();
  listeners.add(fn);

  if (tick === null) {
    // Kick a sync immediately, then tick. The first reading may briefly use a stale offset, which
    // is still no worse than the raw local clock it replaced.
    void syncServerClock().then(() => {
      now = serverNow();
      notify();
    });
    tick = setInterval(() => {
      now = serverNow();
      notify();
    }, 1000);
    resync = setInterval(() => void syncServerClock(), RESYNC_MS);
  }

  return () => {
    listeners.delete(fn);
    if (listeners.size > 0) return;
    if (tick !== null) {
      clearInterval(tick);
      tick = null;
    }
    if (resync !== null) {
      clearInterval(resync);
      resync = null;
    }
  };
}

/** Stand-in for before there's a match to count, so no timer runs at all in a lobby. */
function subscribeNever(): () => void {
  return () => {};
}

/** What the clock reads, plus why it is or isn't moving. */
export interface BattleClockInfo extends BattlePhaseInfo {
  pause: PauseInfo;
}

/**
 * The full clock, re-rendering the caller once a second.
 *
 * For components that DRAW the time. Anything that only wants to know whether firing is open wants
 * `useBattlePhaseName` instead - see the note above.
 *
 * Reads `serverNow()` rather than `Date.now()`: the start instant this counts from is a Postgres
 * timestamp, so the two have to be on the same clock or every player's timer is offset by whatever
 * their own PC clock is wrong by. See lib/serverTime.ts.
 */
export function useBattleClock(attacks: Attack[], room?: Room | null): BattleClockInfo | null {
  const startedAt = matchStartedAt(attacks);
  const running = startedAt !== null;

  // The snapshot is the raw millisecond reading - a number, so React can compare it - and the phase
  // is derived from it during render. Returning the BattlePhaseInfo object from getSnapshot instead
  // would hand React a fresh object identity on every call, which it reads as "changed" forever.
  const getNow = useCallback(() => (running ? now : 0), [running]);
  const nowMs = useSyncExternalStore(running ? subscribe : subscribeNever, getNow, getNow);

  // Derived here rather than taken from usePauseInfo, so the two numbers that have to agree - the
  // instant the clock is read at, and the stopped time coming off it - are both taken from this
  // render's single reading of `now`. Two hooks sampling the tick a millisecond apart is how a
  // frozen clock ends up drifting by one second and back again.
  const pause = pauseInfoAt(room, nowMs);
  const info = battlePhaseAt(startedAt, nowMs, matchTimings(room), pause);
  return info && { ...info, pause };
}

/**
 * Which phase the battle is in, and nothing else.
 *
 * Rides the same tick, but its snapshot is the phase NAME, so React only re-renders the caller on
 * the two or three occasions in a match when that string actually changes. This is what stops the
 * clock from repainting the whole board every second.
 */
export function useBattlePhaseName(attacks: Attack[], room?: Room | null): BattlePhaseName | null {
  const startedAt = matchStartedAt(attacks);
  const running = startedAt !== null;
  const { starting, matchBeginsAt } = matchTimings(room);

  // Depends on the timing NUMBERS rather than the object matchTimings builds fresh each render -
  // an unstable getSnapshot identity would make useSyncExternalStore resubscribe every render.
  // Pause-aware for the same reason the clock is: RANDOMIZATION and PREPARATION are time windows,
  // so a pause called during either has to hold them where they are rather than letting the room
  // walk into the match while everybody is away from their desk.
  const pauseAt = room?.pause_at ?? null;
  const resumeAt = room?.resume_at ?? null;
  const pauseLog = room?.pause_log ?? null;

  const getPhase = useCallback(
    () =>
      startedAt
        ? (battlePhaseAt(
            startedAt,
            now,
            { starting, matchBeginsAt, preparation: matchBeginsAt - starting },
            pauseInfoAt({ pause_at: pauseAt, resume_at: resumeAt, pause_log: pauseLog }, now)
          )?.phase ?? null)
        : null,
    [startedAt, starting, matchBeginsAt, pauseAt, resumeAt, pauseLog]
  );

  return useSyncExternalStore(running ? subscribe : subscribeNever, getPhase, getPhase);
}

/**
 * The pause on its own, for the controls and the banner that draw it.
 *
 * Rides the same tick as the two hooks above, and takes the same trick `useBattlePhaseName` does to
 * stay cheap: the snapshot is a STRING built from the phase and the whole second showing on the
 * countdown, so a caller re-renders when the digit changes and not sixty times between. A room with
 * no pause on it never subscribes at all, which is every room for almost all of every match.
 *
 * Separate from useBattleClock because the two are drawn by different components in different
 * corners of the screen, and the banner must not have to mount a clock to know a pause is on.
 */
export function usePauseInfo(room?: Room | null): PauseInfo {
  const pauseAt = room?.pause_at ?? null;
  const resumeAt = room?.resume_at ?? null;
  const pauseLog = room?.pause_log ?? null;
  const fields = { pause_at: pauseAt, resume_at: resumeAt, pause_log: pauseLog };

  // No pause in flight means nothing here changes with time, so no timer needs to exist - which is
  // the state a room is in for all of almost every match. Note this turns on pause_at alone and not
  // on the log: a room with three closed windows behind it and none open is just running.
  const idle = pauseAt === null;

  const getKey = useCallback(() => {
    const info = pauseInfoAt({ pause_at: pauseAt, resume_at: resumeAt, pause_log: pauseLog }, now);
    return `${info.phase}:${Math.ceil(info.countdown)}`;
  }, [pauseAt, resumeAt, pauseLog]);

  useSyncExternalStore(idle ? subscribeNever : subscribe, getKey, getKey);

  // serverNow() rather than the module's `now` on the idle path: nothing has been ticking it, so it
  // can be arbitrarily stale, and the accumulated total read off a stale instant would be short.
  return pauseInfoAt(fields, idle ? serverNow() : now);
}
