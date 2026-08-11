import { useCallback, useEffect, useState } from "react";

/**
 * A yes/no preference that persists, and that is written ONLY when somebody actually chooses.
 *
 * -- Why this exists ------------------------------------------------------------------------------
 *
 * Two settings here have been flipped from opt-in to on-by-default - the dead-water crosses and the
 * movable canvas - and neither flip reached a single existing player. Both were written the obvious
 * way: state seeded from localStorage, and an effect persisting it.
 *
 *     const [on, setOn] = useState(() => localStorage.getItem(KEY) !== "0");
 *     useEffect(() => { localStorage.setItem(KEY, on ? "1" : "0"); }, [on]);
 *
 * That effect runs on MOUNT, not just on change. So under the original opt-in code, every browser
 * that ever opened a match wrote "0" to the key - without the player touching anything, without a
 * preference ever having been expressed. When the default later flipped, the read said "on unless
 * this browser explicitly turned it off", and every one of those browsers was carrying an explicit
 * "off" it had written to itself. The new default only ever reached someone opening the app for the
 * first time on a clean profile - which is to say, nobody who had been playing.
 *
 * Storing a default is the whole bug: it turns "no opinion" into "opinion: whatever shipped that
 * week", and freezes it. Absent has to keep meaning absent, so a default can still be changed later.
 * Hence writing in the setter instead of in an effect - there is no code path here that can persist
 * a value the caller didn't ask for.
 *
 * @param fallback what to use when nothing is stored - the default, and changeable later precisely
 * because it is never written down.
 * @param retire a superseded key to delete, for a default that has already been flipped underneath
 * the old one. The stale "0"s it holds cannot be told apart from deliberate ones, so the key is
 * abandoned rather than migrated: the accidental writes are almost all of them, and someone who
 * genuinely wants it off need only click the toggle once more.
 */
export function useStoredToggle(
  key: string,
  fallback: boolean,
  retire?: string
): readonly [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => read(key, fallback));

  useEffect(() => {
    if (!retire) return;
    try {
      localStorage.removeItem(retire);
    } catch {
      // Private mode. Leaving a dead key behind costs nothing; it is already being ignored.
    }
  }, [retire]);

  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Private mode or quota. A preference that doesn't stick is a nuisance, not a broken match.
      }
    },
    [key]
  );

  return [value, set] as const;
}

/** Absent means absent: no stored value hands back the default rather than a guess at one. */
function read(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
}

/**
 * A numeric preference, under exactly the rule set out above: nothing is written until somebody
 * chooses one. Same reasoning, same shape - see useStoredToggle for why the write lives in the
 * setter and not in an effect.
 *
 * @param allowed every value this setting may take. A stored number outside the set is treated as
 * absent rather than trusted, so a hand-edited key or a preset list that has since changed can't
 * feed a nonsense value to whatever consumes it - which for the firing hold is a timer measured in
 * milliseconds, where "absent" is recoverable and "600000" is a square that never fires.
 */
export function useStoredNumber(
  key: string,
  fallback: number,
  allowed: readonly number[]
): readonly [number, (next: number) => void] {
  const [value, setValue] = useState(() => readNumber(key, fallback, allowed));

  const set = useCallback(
    (next: number) => {
      setValue(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // Private mode or quota, as above.
      }
    },
    [key]
  );

  return [value, set] as const;
}

function readNumber(key: string, fallback: number, allowed: readonly number[]): number {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return fallback;
    const parsed = Number(stored);
    return allowed.includes(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
