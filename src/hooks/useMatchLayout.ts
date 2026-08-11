import { usePanelLayout } from "./usePanelLayout";
import { DEFAULT_LAYOUT, PANEL_IDS, type PanelId } from "../lib/matchLayout";

/**
 * The player's match-screen arrangement, and whether they're using it.
 *
 * A thin binding of usePanelLayout to the match screen's five fixed panels - the spectator canvas
 * binds the same hook to its own, room-dependent set. See usePanelLayout for what's stored and why.
 */
export function useMatchLayout() {
  return usePanelLayout<PanelId>("eb_match_layout", PANEL_IDS, DEFAULT_LAYOUT);
}
