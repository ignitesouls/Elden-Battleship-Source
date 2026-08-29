import { useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useOverlayToken } from "../hooks/useOverlayToken";
import { OverlayBoard } from "./OverlayBoard";
import { OverlayFleet } from "./OverlayFleet";
import { OverlayTimer } from "./OverlayTimer";
import { OverlayKey } from "./OverlayKey";
import { OverlayOdds } from "./OverlayOdds";
import { OverlayAudio } from "./OverlayAudio";
import { OverlayEgg } from "./OverlayEgg";
import { CasterControl } from "./CasterControl";
import { setEgressRoom } from "../lib/egressMeter";
import type { StreamElement } from "../lib/streamOverlay";

/**
 * A persistent browser source: /stream/board?token=..., and one for every other overlay element.
 *
 * -- What this page is -------------------------------------------------------------------------
 *
 * Not an overlay. It is the piece of wiring that turns "whoever owns this token" into "this room",
 * and then hands that room to the overlay page that was going to draw it anyway. The drawing is
 * entirely unchanged: the same OverlayBoard, the same scorebug, the same key strip that a
 * hand-pasted /overlay-board/AB12CD URL mounts, told which room to use by a prop instead of by the
 * path. See hooks/useOverlaySource for why that is a prop rather than a redirect.
 *
 * The whole point is that the URL never changes. It is configured once, in an OBS Browser Source,
 * and from then on it follows its owner: into a lobby, into a match, out the other side, into the
 * next one. Nobody edits anything between matches, which is the job this feature exists to delete.
 *
 * -- The empty states ----------------------------------------------------------------------------
 *
 * Three of them, and all three draw nothing at all:
 *
 *   * still resolving        - one round trip, and a source that flashed something in the meantime
 *                              would flash it on every OBS restart
 *   * no such token          - revoked, rotated, or mistyped
 *   * a token with no room   - its owner is not in a match right now
 *
 * Nothing is the correct picture for all three, and it is emphatically better than the alternative:
 * a source left up between matches must never keep drawing the LAST match. A stale board on a stream
 * is worse than a blank one, because a blank one is obviously blank and a stale one is quietly wrong.
 * There is deliberately no error text either - an OBS source is composited over somebody's gameplay,
 * and "no such token" burned into the middle of their footage helps nobody who is live.
 *
 * The one exception is the caster's control page, which is a page on a second monitor rather than a
 * source in a scene, and can therefore say what is going on.
 */

/** The room, and the team its owner is on, injected into whichever element was asked for. */
function element(
  name: StreamElement,
  code: string,
  params: URLSearchParams
) {
  switch (name) {
    case "board":
      return <OverlayBoard code={code} search={params} />;
    case "fleet":
      return <OverlayFleet code={code} search={params} />;
    case "timer":
      return <OverlayTimer code={code} search={params} />;
    case "key":
      return <OverlayKey code={code} search={params} />;
    case "odds":
      return <OverlayOdds code={code} search={params} />;
    case "audio":
      return <OverlayAudio code={code} search={params} />;
    case "egg":
      return <OverlayEgg code={code} search={params} />;
  }
}

const ELEMENTS: StreamElement[] = ["board", "fleet", "timer", "key", "odds", "audio", "egg"];

export function StreamSource() {
  const { element: name } = useParams<{ element: string }>();
  const [params] = useSearchParams();
  const token = params.get("token");

  const { loading, session } = useOverlayToken(token);

  /**
   * The transparent-background opt-out, taken here as well as in each page.
   *
   * The pages do it themselves, but only once they have a room to draw - and this route spends real
   * time with no room at all, on every OBS start and between every pair of matches. Without it those
   * gaps composite the site's own dark background over the streamer's gameplay, which is the exact
   * failure the class exists to prevent. Doing it twice is harmless: both are adding the same class.
   */
  useEffect(() => {
    if (name === "cast") return;
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, [name]);

  /**
   * The query the page underneath actually sees.
   *
   * `token` is stripped, because nothing downstream should be able to read it out of the search
   * params by accident - the one page that legitimately wants it, the fleet source, is handed it
   * back explicitly below.
   *
   * `me=1` is swapped for the resolved seat's `team=N`, and this is the whole reason the wrapper
   * stays mounted rather than baking a team into the URL at download time: a player who switches
   * fleets between matches, or who is on Red one night and Blue the next, would otherwise have a
   * scene quietly marking the wrong crew as theirs.
   *
   * It is a marker rather than an unconditional fill, because `team` is not a neutral parameter.
   * Written onto a caster's driven board it PINS the source (see pinnedView in OverlayBoard) and
   * disconnects it from the control page; written onto the caster's clock it puts a crew highlight
   * inside an odds band that is deliberately about the whole room. Only the sources that asked for
   * it get it - see followsTeam in lib/streamSources.
   *
   * An existing `team` in the URL wins, so a hand-edited source still does what it says.
   */
  const search = useMemo(() => {
    const next = new URLSearchParams(params);
    next.delete("token");
    const wantsTeam = next.get("me") === "1";
    next.delete("me");
    if (wantsTeam && session?.team !== null && session?.team !== undefined && !next.has("team")) {
      next.set("team", String(session.team));
    }
    // The fleet source resolves its ships from the token itself rather than from a rejoin code, so
    // it is the one element that gets it back. See fetchOverlayFleetByToken.
    if (name === "fleet" && token) next.set("token", token);
    return next;
  }, [params, session?.team, name, token]);

  /**
   * Tell the byte meter which room this source ended up in.
   *
   * /stream/:element is the one route with no room code in the URL - that is the entire point of it,
   * since a Browser Source URL that names a room goes stale the moment the match does. So the meter
   * cannot read a room off the route here, and without this a persistent OBS scene would be the one
   * set of tabs that never reported, while being the tabs most worth measuring: seven of them per
   * streamer, each an independent realtime subscriber.
   *
   * The caster desk names itself, because it is a person at a second monitor rather than a source in
   * a scene, and the two cost very different amounts.
   */
  useEffect(() => {
    if (session?.roomCode) setEgressRoom(session.roomCode, name === "cast" ? "caster" : "overlay");
  }, [session?.roomCode, name]);

  // The caster's desk, following them by token the same way their sources do. Not a browser source -
  // it is an ordinary page on a second monitor, so it keeps the app's chrome and is allowed to
  // explain itself when there is nothing to drive.
  if (name === "cast") {
    if (loading) return null;
    if (!session?.roomCode) {
      return (
        <div className="stack" style={{ width: "min(860px, 100%)", gap: "0.5rem" }}>
          <h2>Caster desk</h2>
          <p className="muted">
            {session
              ? "You're not in a room right now. Join one as a spectator and this page will pick it up on its own - no need to reload."
              : "That overlay token isn't valid. Generate a new one on the OBS & auto-marking page."}
          </p>
        </div>
      );
    }
    return <CasterControl code={session.roomCode} />;
  }

  if (loading || !session?.roomCode) return null;
  if (!name || !(ELEMENTS as string[]).includes(name)) return null;

  return element(name as StreamElement, session.roomCode, search);
}
