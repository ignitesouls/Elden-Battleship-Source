import { useEffect, useState } from "react";
import { useOverlaySource, type OverlaySourceProps } from "../hooks/useOverlaySource";
import { useRoom } from "../hooks/useRoom";
import { useBoxSize } from "../hooks/useBoxSize";
import { useBattlePhaseName } from "../hooks/useBattlePhase";
import { fetchOverlayFleet, fetchOverlayFleetByToken, type OverlayFleet as OwnFleet } from "../lib/overlayFleet";
import { sunkCellOrientations } from "../lib/battleshipLogic";
import { cellVisuals } from "../lib/cellVisuals";
import { challengesForRoom } from "../lib/challenges";
import { squaresRevealed } from "../lib/overlayReveal";
import { readOpacity, readEmptyFade } from "../lib/overlayCast";
import { teamHex } from "../lib/teamColors";
import { useT } from "../lib/language";
import { BoardGrid, type CellVisual, type ShipOverlay } from "../components/BoardGrid";
import "./Overlay.css";
import "./OverlayTiers.css";
import "./OverlayFleet.css";

/** What the source draws at before OBS has measured it. Square, like the board. */
const SOURCE_SIZE = 400;

/**
 * The player's own fleet board, as an OBS Browser Source: "here is where my ships are".
 *
 * -- Why this is not the board source in a smaller rectangle -------------------------------------
 *
 * /overlay-board can already draw the owner's hulls (see its ?key= note), and an OBS source can be
 * made any size, so on paper this is that board at 400px. It isn't, because that board is built
 * around square NAMES - fitted per square, grown to fill, with the coordinate gutter turned up loud
 * so a caster can say "D7" to several thousand people. Every one of those decisions needs area.
 * Shrink it into a corner and the names go to mush, and what is left is a board that is mostly
 * unreadable text.
 *
 * The players' own fleet panel already solved this, because it has always been the small board on a
 * screen the fire board dominates: it drops the names entirely and wears each square's challenge
 * COLOUR instead (see the fleetBoard note in room/BattlePhase). That answers the question this
 * source is actually asked - which bosses am I sitting on? - at a size that survives an encoder. So
 * this is that panel and nothing else: the same hulls, the same tint, the same wreckage.
 *
 * The trade is deliberate and worth saying out loud: a viewer sees the shape of the fleet and the
 * colour under it, not a list of bosses. Matching that colour against the big board, or the key
 * strip, is what turns it back into names - and the player or the caster saying them is what turns
 * it into a sentence. This source's job is to be the picture.
 *
 * -- What it takes -------------------------------------------------------------------------------
 *
 *     ?key=ABC123        the owner's rejoin code. Without it there is nothing to draw.
 *     ?opacity=0.5       see-through, so gameplay reads underneath it
 *     ?coords=1          add the A-J / 1-10 gutter, off by default
 *
 * There is deliberately no ?team=. The rejoin code names exactly one fleet and that is the only
 * fleet this page can ever draw, which is what makes "show my ships" safe to offer as a plain
 * yes/no: the URL has no way of being pointed at somebody else's board.
 */
export function OverlayFleet(props: OverlaySourceProps = {}) {
  // The room and the query string come from the URL, or from the persistent stream route that has
  // resolved them off an overlay token. See hooks/useOverlaySource for why this page takes props.
  const { code, params } = useOverlaySource(props);
  const t = useT();
  const key = params.get("key") ?? "";
  /**
   * The persistent overlay's credential, when this source is one.
   *
   * Read straight off the query rather than passed down as a prop, so the two ways in stay symmetric:
   * a room-coded URL carries `?key=` and a persistent one carries `?token=`, and this page picks
   * whichever it was handed. The token is much the better of the two to have in a scene file - it
   * cannot be redeemed for the seat. See fetchOverlayFleetByToken.
   */
  const token = params.get("token") ?? "";
  const opacity = readOpacity(params);
  /**
   * The coordinate gutter, off unless asked for.
   *
   * The caster's board turns these up loud because they are the only way to say WHERE on a stream
   * nobody can point at. This source is small and usually parked beside gameplay, and the gutter
   * costs a band on all four edges of an already-small board. Anyone who wants to give chat a
   * vocabulary can switch them on; the default is the picture.
   */
  const coords = params.get("coords") === "1";

  const state = useRoom(code);

  /**
   * The owner's fleet, through the same RPC and the same credential the board source uses.
   *
   * Tri-state on purpose. `undefined` is "not answered yet" and draws nothing; `null` is "asked and
   * got nothing back", which is a broken URL and says so on stream. Collapsing the two would flash
   * a fault notice into a scene every time the source started up.
   *
   * Re-fetched when the room's status changes, because placements are replaced wholesale on a
   * rematch - a source left running overnight would otherwise still be drawing last night's fleet.
   */
  const [fleet, setFleet] = useState<OwnFleet | null | undefined>(undefined);
  const roomStatus = state.room?.status;
  useEffect(() => {
    // The token is preferred when both are present, which in practice they never are. It resolves the
    // room server-side as well as the player, so it keeps working across matches; the rejoin code is
    // scoped to one room by construction and would go stale the moment its owner joined another.
    if (token) {
      let cancelled = false;
      void fetchOverlayFleetByToken(token).then((f) => {
        if (!cancelled) setFleet(f);
      });
      return () => {
        cancelled = true;
      };
    }
    if (!code || !key) {
      setFleet(null);
      return;
    }
    let cancelled = false;
    void fetchOverlayFleet(code, key).then((f) => {
      if (!cancelled) setFleet(f);
    });
    return () => {
      cancelled = true;
    };
    // `roomStatus` is not read here and is not meant to be: it is in the list purely as the signal to
    // re-fetch, because placements are replaced wholesale on a rematch. It does that job for the
    // token path too, and the token path additionally re-runs when a new room resolves.
  }, [code, key, token, roomStatus]);

  const [frameRef, frame] = useBoxSize<HTMLDivElement>();

  // The same transparency opt-out every other source makes - see the note in Overlay.css.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  const room = state.room;
  // Drives the tint gate below: colours hold until the board has finished being dealt.
  const battlePhase = useBattlePhaseName(state.attacks, room);
  if (!room) return null;

  // A fault said where the person who can fix it is looking, which is the stream - same reasoning
  // as the board source's "board control disconnected" badge. A silently blank source looks exactly
  // like a working one that has nothing to say yet, and that is the failure that costs a stream.
  if (fleet === null) {
    return (
      <div className="ovf-frame" ref={frameRef}>
        <div className="ovf-fault">
          {key
            ? t("no fleet for this code", "aucune flotte pour ce code")
            : t("no ?key= in this URL", "aucun ?key= dans cette URL")}
        </div>
      </div>
    );
  }
  if (fleet === undefined) return <div className="ovf-frame" ref={frameRef} />;

  const boardSize = room.board_size;
  /**
   * Squares wear their colour only once the board has stopped being dealt - the same gate the names
   * are behind, for the same reason (see lib/overlayReveal).
   *
   * A tint is a weaker read than a name, but it is the same KIND of read: park a hull on the
   * squares whose region nobody opens with and placement has been played with information placement
   * isn't given. It is also exactly what the player's own screen does - their placement board is
   * bare water, and the tint arrives with the fleet panel - so holding it here keeps the promise
   * this source is built on, that it shows what they see.
   */
  const revealed = squaresRevealed(room.status, battlePhase);
  const challenges = challengesForRoom(
    room.id,
    boardSize * boardSize,
    room.square_set,
    room.seed,
    room.board_perm,
    room.seed_set_at
  );

  // Shots fired AT this fleet. Public rows out of the log, not anything the rejoin code unlocked -
  // the credential is only ever spent on the hulls.
  const incoming = state.attacks.filter((a) => a.defender_team === fleet.team);
  const sunkCells = sunkCellOrientations(incoming, boardSize);
  const visuals = cellVisuals(incoming, sunkCells);
  const cellVisual = (index: number): CellVisual => visuals.get(index) ?? "empty";

  const ships: ShipOverlay[] = fleet.placements.map((p) => ({
    row: p.startRow,
    col: p.startCol,
    size: room.ship_defs[p.shipIndex]?.size ?? 1,
    horizontal: p.isHorizontal,
    shipName: room.ship_defs[p.shipIndex]?.name ?? "Destroyer",
    colorHex: teamHex(fleet.team),
  }));

  // Square as big as the shorter side of the source. A board is square, so a source that isn't
  // leaves margin on its long axis - which is what the centring in the stylesheet is for.
  const boardPx = frame.w > 0 ? Math.round(Math.min(frame.w, frame.h)) : SOURCE_SIZE;

  return (
    <div className={`ovf-frame ovf-board ovl-fade${coords ? "" : " ovf-no-coords"}`} ref={frameRef}>
      {/* The fade sits on the board rather than the frame, so a fault notice never goes faint along
          with it. Three tiers off the one slider, exactly as the big board - see OverlayTiers.css.
          The reasoning carries over intact: this panel is water, hulls and wreckage in the same
          layers, and a flat opacity took the hulls down with the water it was asked to thin. */}
      <div
        className="ovf-stage ovl-fade-stage"
        style={{
          ["--ovl-a-bg" as string]: opacity,
          // Same setting the fire board takes, so a crew's two boards fade together - see
          // readEmptyFade. Here it thins the water their own hulls are sitting in.
          ["--ovl-a-empty" as string]: readEmptyFade(params),
        }}
      >
        <BoardGrid
          boardSize={boardSize}
          cellVisual={cellVisual}
          ships={ships}
          sunkOrientation={sunkCells}
          // Labels are top and left everywhere now - see the coord note in BoardGrid. It mattered
          // most here: this source is a fraction of the board source's size, so two extra gutter
          // tracks came straight out of cells already down at 28px. ?coords=0 still collapses the
          // two that remain - see the rule in the stylesheet, which gives those pixels back.
          // Both bounds the same, because BoardGrid resolves min(maxVh, maxVw) to a square.
          maxVh={`${boardPx}px`}
          maxVw={`${boardPx}px`}
          // No cellText at any size. See the note at the top: names are the thing this source gives
          // up, and a board that tried to draw them here would only be worse at both jobs.
          cellTint={
            revealed
              ? (i) => {
                  const c = challenges[i];
                  return c ? { region: c.region, color: c.color } : null;
                }
              : undefined
          }
          // Deliberately NOT passed: deepCells. The fleet board has never carried what is hiding in
          // the water - the cell index is shared with the hunting board, so a whale drawn here would
          // suggest it belonged to this fleet's waters, and there is no such thing.
        />
      </div>
    </div>
  );
}
