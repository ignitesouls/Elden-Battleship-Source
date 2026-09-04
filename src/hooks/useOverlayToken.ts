import { useFollowedSeat, type FollowedSeatState } from "./useFollowedSeat";
import { resolveOverlaySession, type OverlaySession } from "../lib/streamOverlay";

export type OverlayTokenState = FollowedSeatState<OverlaySession>;

/**
 * Follows the token's owner from match to match, so an OBS Browser Source URL never has to change.
 *
 * All of the machinery is in useFollowedSeat, along with the argument for why this watches a
 * subscription instead of polling - the watch link is built on the same hook, and that reasoning is
 * the part that must not exist twice. What is left here is the one thing that is actually specific
 * to an overlay: which credential opens the door.
 */
export function useOverlayToken(token: string | null | undefined): OverlayTokenState {
  return useFollowedSeat(token, resolveOverlaySession, "overlay-seat");
}
