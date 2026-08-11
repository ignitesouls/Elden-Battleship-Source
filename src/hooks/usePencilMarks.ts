import { useCallback, useEffect, useState } from "react";

/**
 * What a player has written on a square by hand.
 *
 * "guess" is the pencil mark - I reckon something is here.
 *
 * "ruled" was its opposite, crossed out with a middle-click: a square that CANNOT hold anything.
 * Nothing makes one any more. The board now works that deduction out for itself and draws it on
 * every square it holds for, on by default (see lib/deduction), which is a strictly better answer
 * than asking a player to spot the same gaps by hand and click each one - so the gesture went, and
 * with it the wheel-click that Chrome and Firefox both wanted for their autoscroll widget.
 *
 * The kind stays in the type because a player mid-match has crossed squares sitting in localStorage,
 * and they still read back, still draw, and are still cleared by the Clear notes button. Losing an
 * hour of board-reading to a deploy is the thing this hook exists to prevent.
 */
export type MarkKind = "guess" | "ruled";

/**
 * How the board annotations are made. Lives on the button that clears them, which is the only
 * place either gesture is ever advertised - neither has a control of its own to discover.
 */
export const NOTE_HINT =
  "Right-click a square to pin a guess. Scroll the wheel over a square to count it up or down.";

/**
 * Client-local marks: right-click pins a guess.
 *
 * A gesture that sets one kind rather than a button cycling none -> guess -> none -> ... A board
 * gets marked in bursts while someone reads it aloud, and at that speed a state flashing up on the
 * way to the one you wanted is exactly the sort of thing that gets a square mis-read.
 *
 * Never sent to the server - they're one player's private deduction, and publishing them would leak
 * exactly the reasoning that wins a match. Persisted to localStorage per room so a refresh mid-match
 * doesn't wipe the board-reading work the player has already done.
 *
 * Square TALLIES used to live here too and no longer do: those are shared with the fleet, so they
 * need a server round trip and their own realtime channel. See useSquareCounts.
 */
export function usePencilMarks(roomCode: string | undefined) {
  const storageKey = roomCode ? `eb_marks_${roomCode}` : null;

  const [marks, setMarks] = useState<Map<number, MarkKind>>(() => {
    if (!storageKey) return new Map();
    try {
      return parseMarks(localStorage.getItem(storageKey));
    } catch {
      return new Map();
    }
  });

  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(marks)));
    } catch {
      // Private-mode / quota failures are not worth surfacing over a cosmetic annotation.
    }
  }, [storageKey, marks]);

  /**
   * Sets a square to `kind`, or clears it if it was already that kind.
   *
   * A square holds one mark, so pinning a crossed-out square replaces the cross rather than
   * stacking on it - "I've changed my mind about this square" is the only thing that can mean.
   */
  const toggle = useCallback((index: number, kind: MarkKind) => {
    setMarks((prev) => {
      const next = new Map(prev);
      if (prev.get(index) === kind) next.delete(index);
      else next.set(index, kind);
      return next;
    });
  }, []);

  const clear = useCallback(() => setMarks(new Map()), []);

  return { marks, toggle, clear };
}

/**
 * Reads back either storage shape.
 *
 * Marks were an array of cell indices when the only kind was a pinned guess, and are an
 * index-to-kind object now that there are two. A player mid-match when the new build lands still
 * has the old shape sitting in localStorage, and losing an hour of board-reading to a deploy is
 * exactly the thing this hook persists to prevent - so the array is read as all-guesses.
 */
function parseMarks(raw: string | null): Map<number, MarkKind> {
  if (!raw) return new Map();
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return new Map(parsed.filter((i): i is number => Number.isInteger(i)).map((i) => [i, "guess" as const]));
  }
  const out = new Map<number, MarkKind>();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const index = Number(k);
    if (!Number.isInteger(index)) continue;
    if (v === "guess" || v === "ruled") out.set(index, v);
  }
  return out;
}
