import { useCallback, useEffect, useMemo, useState } from "react";
import { useStoredToggle } from "./useStoredToggle";
import {
  clampBox,
  mergeLayout,
  parseOverrides,
  restack,
  type PanelBox,
  type PanelLayout,
} from "../lib/panelLayout";

/**
 * One screen's panel arrangement, and whether the viewer is using it.
 *
 * Keyed on nothing but the browser - not the room, unlike pencil marks. A layout is a preference
 * about how someone likes to read the screen, so it should follow them into every match rather
 * than resetting each time they join a new room.
 *
 * Only the panels actually dragged are stored (see parseOverrides). Everything else keeps following
 * whatever default the caller computes, which is what lets the spectator canvas re-tile itself when
 * a fleet joins or the view switches without discarding the panels the caster did place.
 *
 * localStorage only for now. The profiles.layout column that syncs this across devices via Twitch
 * is a deliberate follow-up: the shape stored here should settle after people have actually dragged
 * panels around, not before.
 */
export function usePanelLayout<Id extends string>(
  /** Distinguishes one screen's saved arrangement from another's, e.g. "eb_match_layout". */
  storageKey: string,
  ids: Id[],
  defaults: PanelLayout<Id>
) {
  const [overrides, setOverrides] = useState<Partial<PanelLayout<Id>>>(() => {
    try {
      return parseOverrides<Id>(localStorage.getItem(storageKey));
    } catch {
      return {};
    }
  });

  /**
   * Whether the movable canvas is in use. ON, unless this browser has actually chosen otherwise.
   *
   * It started opt-in, on the theory that rearranging the screen under someone was the rude thing to
   * do. It turned out to be the other way round: the canvas is how people want to read the match, and
   * shipping it off by default meant most players never found it at all.
   *
   * That flip was made once already and reached nobody, because the key was written on mount: every
   * browser that had opened a match while this was still opt-in had stored an "off" it never chose,
   * and the read could not tell that from a decision. The key is retired rather than migrated (see
   * useStoredToggle), so the default lands on everyone and a fixed-layout regular clicks once to get
   * it back - with the lock button there for anyone who wants the panels to stop moving instead.
   */
  const [enabled, setEnabled] = useStoredToggle(`${storageKey}_on_v2`, true, `${storageKey}_on`);

  /**
   * Whether the arrangement is frozen.
   *
   * Persisted like the layout itself, and for the same reason: someone who has spent a match
   * getting their panels right and locked them wants to find them locked next time, not to
   * rediscover that a mis-aimed click can shove the board across the screen.
   *
   * Its key needs no retiring: this default has never moved, so the "0"s the old mount-write left
   * behind say exactly what the absent value would have.
   */
  const [locked, setLocked] = useStoredToggle(`${storageKey}_locked`, false);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(overrides));
    } catch {
      // Private mode or quota. A layout that doesn't persist is a nuisance, not a broken match.
    }
  }, [storageKey, overrides]);

  // ids is usually a fresh array literal from the caller, so the identity that matters is its
  // contents - without this every render would rebuild the layout and defeat the memo below.
  const idKey = ids.join("|");
  const layout = useMemo(
    () => mergeLayout(ids, defaults, overrides),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idKey, defaults, overrides]
  );

  /** Clamped on write as well as on read, so nothing can ever be parked out of reach. */
  const setPanel = useCallback((id: Id, box: PanelBox) => {
    setOverrides((prev) => ({ ...prev, [id]: clampBox(box) }));
  }, []);

  /**
   * Send a panel to the top or bottom of the stack.
   *
   * Restacking commits every VISIBLE panel's current box, not just the moved one: z is only
   * meaningful relative to its neighbours, so keeping one panel's new level while the others stayed
   * free to re-tile would have the stack mean something different the next time the room changed
   * shape. Panels that aren't on screen keep whatever was already stored for them.
   */
  const setStack = useCallback(
    (id: Id, to: "front" | "back") => {
      setOverrides((prev) => ({ ...prev, ...restack(ids, mergeLayout(ids, defaults, prev), id, to) }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idKey, defaults]
  );

  /**
   * Back to the shipped arrangement.
   *
   * Deliberately still works while locked, and deliberately doesn't unlock: this is the escape
   * hatch for a panel dragged somewhere unusable, and it lives outside the canvas where nothing
   * can be dropped on top of it.
   */
  const reset = useCallback(() => setOverrides({}), []);

  return { layout, setPanel, setStack, reset, enabled, setEnabled, locked, setLocked };
}
