import { useFollowedSeat, type FollowedSeatState } from "./useFollowedSeat";
import { resolveWatchSession, type WatchSession } from "../lib/watchStream";

export type WatchSessionState = FollowedSeatState<WatchSession>;

/**
 * Two answers are the same picture when nothing a viewer can see has moved.
 *
 * The three seat fields are the default comparison and would nearly do. `showFleet` is the reason
 * this is spelled out: it is a switch its owner can flip mid-match, and it decides whether the
 * second board has hulls on it. Left out, a streamer turning their fleet OFF on stream would go on
 * showing it to everybody already watching until they happened to change rooms.
 *
 * `streamerName` for the smaller version of the same thing - a rename should reach the page it is
 * the title of.
 */
function samePicture(prev: WatchSession, next: WatchSession | null): boolean {
  return (
    prev.roomCode === (next?.roomCode ?? null) &&
    prev.team === (next?.team ?? null) &&
    prev.status === (next?.status ?? null) &&
    prev.showFleet === (next?.showFleet ?? false) &&
    prev.streamerName === (next?.streamerName ?? null)
  );
}

/**
 * Follows a streamer from match to match, so the link in their Twitch panel never goes stale.
 *
 * The machinery - and the argument for why this watches a subscription rather than polling, which
 * matters far more with an audience behind it than with one OBS scene - is in useFollowedSeat. This
 * is the overlay hook's twin with a public handle at the door instead of a private token.
 */
export function useWatchSession(handle: string | null | undefined): WatchSessionState {
  return useFollowedSeat(handle, resolveWatchSession, "watch-seat", samePicture);
}
