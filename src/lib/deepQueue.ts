import type { DeepMark } from "./deepWater";
import { isHeadline } from "./deepLabels";

/**
 * Deciding what the water just gave up, for everything that announces it.
 *
 * The sound source and the alert source watch the same thing and have to reach the same conclusion,
 * or a stream shows a whale while the speakers stay quiet. They used to reach it separately - the
 * same keying rule written out twice, and two different opinions about what to do when several
 * squares change at once - which is exactly the kind of agreement that holds until the one night it
 * matters.
 *
 * So the decision lives here, as a pure function over a tick, and both callers do as they are told
 * with it. It is also the only shape this logic can be tested in: the callers are React hooks, and
 * what needs asserting is a policy rather than a render. See scripts/check-deep-alert.ts.
 */

/**
 * How a find is identified: the square AND what is on it.
 *
 * Not the square alone. Cthulhu wakes by turning every tentacle already found into a sleeper, and
 * Alexander comes free on the same square he was stuck in - so a square whose mark has changed is
 * news, and one keyed by position alone would go unannounced. The same rule is in BattlePhase, which
 * is where it was first needed.
 */
export function deepKey(cell: number, mark: DeepMark): string {
  return `${cell}:${mark}`;
}

/** One thing found, with whatever the caller needs to draw or play it attached. */
export interface DeepEvent<T> {
  cell: number;
  mark: DeepMark;
  item: T;
}

export interface FreshFinds<T> {
  /** What to announce, in the order to announce it. Empty on the priming pass. */
  fresh: T[];
  /** Everything now known about, for the caller to hold until the next tick. */
  keys: Set<string>;
}

/**
 * What is new since the last tick, collapsed to one entry per EVENT and ordered headline-first.
 *
 * @param events every find currently known, OLDEST FIRST. The order matters - see the collapse.
 * @param seen the keys returned last tick, or null on the first pass.
 *
 * -- Priming ---------------------------------------------------------------------------------------
 *
 * `seen` of null means nothing is fresh, however much is there. A source added to a scene mid-match
 * must not replay the whole hunt into the corner of somebody's stream, and a spectator opening a page
 * an hour in must not be greeted by an hour of sound. The first pass only learns what has already
 * happened.
 *
 * -- One entry per event, not per square -----------------------------------------------------------
 *
 * The wake is the case that forces this. He wakes by turning every tentacle already found from
 * "tentacle" to "sleeper" at once, so a tick that looks like four fresh finds is one thing happening.
 * Announced per square that was four identical alerts over half a minute against a single sting.
 *
 * The LAST of a collapsed group wins, which is why the caller must pass oldest first: for a wake that
 * is the crew who fired the shot that woke him, and theirs is the name that belongs on it. The others
 * were credited when they found their tentacles.
 *
 * -- Headlines first -------------------------------------------------------------------------------
 *
 * The waking and Igon avenged are the biggest things that can happen in a match, and both land in the
 * same tick as the ordinary find that caused them. Sorting them forward means neither ends up behind
 * a bottle in a queue, or dropped by a caller that only has room for one. See isHeadline.
 */
export function freshDeepEvents<T>(
  events: readonly DeepEvent<T>[],
  seen: ReadonlySet<string> | null
): FreshFinds<T> {
  const keys = new Set(events.map((e) => deepKey(e.cell, e.mark)));
  if (seen === null) return { fresh: [], keys };

  // One per mark, last writer winning - see the collapse note above.
  const perMark = new Map<DeepMark, DeepEvent<T>>();
  for (const e of events) {
    if (seen.has(deepKey(e.cell, e.mark))) continue;
    perMark.set(e.mark, e);
  }

  const fresh = [...perMark.values()].sort(
    (a, b) => Number(isHeadline(b.mark)) - Number(isHeadline(a.mark))
  );
  return { fresh: fresh.map((e) => e.item), keys };
}
