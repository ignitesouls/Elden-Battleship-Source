import { useParams, useSearchParams } from "react-router-dom";

/**
 * What an overlay page needs to draw: a room, and a query string.
 *
 * Both optional. Omitted, the page reads them off the router exactly as it always has - which is
 * what every existing /overlay-board/CODE URL still does, unchanged. Supplied, they come from the
 * persistent stream route, which has resolved the room from an overlay token and is handing the same
 * two values in by hand.
 */
export interface OverlaySourceProps {
  code?: string;
  search?: URLSearchParams;
}

/**
 * One room and one query string, from whichever of the two sources is driving this page.
 *
 * -- Why the pages take props at all -------------------------------------------------------------
 *
 * The persistent overlay has to render the SAME components as the room-coded URLs. Not a copy of
 * them: a copy is a second board, a second scorebug and a second key strip, drifting apart one fix
 * at a time, and half the value of this feature is that a streamer's persistent scene looks exactly
 * like the one they already know.
 *
 * The obvious alternative is for /stream/:element to resolve the token and then redirect to
 * /overlay-board/CODE. It works exactly once. The moment it navigates, the component that was
 * watching for the player's next match unmounts with it, and the source is pinned to that room until
 * somebody refreshes it - which is the entire problem this feature exists to remove.
 *
 * So the wrapper stays mounted and passes the room down. Two optional props per page, defaulting to
 * the router, and no page has to know which kind of URL it is serving.
 *
 * Both hooks are called unconditionally whether or not the props are set, because that is the rule
 * for hooks and because a page rendered under the stream route genuinely has no `:code` to read -
 * useParams simply returns undefined for it, which the props then override.
 */
export function useOverlaySource({ code, search }: OverlaySourceProps): {
  code: string | undefined;
  params: URLSearchParams;
} {
  const route = useParams<{ code: string }>();
  const [routeSearch] = useSearchParams();
  return { code: code ?? route.code, params: search ?? routeSearch };
}
