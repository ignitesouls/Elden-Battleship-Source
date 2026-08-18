import { useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { useBoxSize } from "../hooks/useBoxSize";
import { legendItems } from "../lib/legend";
import { fitScale } from "../lib/overlayFit";
import { challengesForRoom } from "../lib/challenges";
import { squaresRevealed } from "../lib/overlayReveal";
import { useBattlePhaseName } from "../hooks/useBattlePhase";
import { readOpacity } from "../lib/overlayCast";
import { readTextSize } from "../lib/overlayText";
import "./Overlay.css";
import "../components/BoardGrid.css";
import "./OverlayKey.css";

/**
 * The colour key, as a strip to run along the bottom of a stream.
 *
 * Its own browser source rather than a corner of the board's, because it wants the opposite shape
 * from everything else: the board is a square that moves and gets pointed at, and this is a single
 * line that spans the screen and never changes for the whole match. Sharing a source would mean one
 * of them compromising, and the caster losing the ability to hide either on its own.
 *
 * Entirely public - the squares dealt to the room and the set they came from - so like the timer it
 * needs no controller and no credential. Paste the URL and it follows the room.
 *
 * It lists only the colours actually ON this board, not everything the set can produce: a board is
 * a hundred squares out of a couple of hundred, so a fixed key would have a viewer hunting the
 * board for a colour that was never dealt. Comes from the same legendItems() the players' own key
 * uses, so what the stream names a colour and what they see beside their board cannot disagree.
 */
export function OverlayKey() {
  const { code } = useParams<{ code: string }>();
  const [params] = useSearchParams();
  const state = useRoom(code);
  const [frameRef, frame] = useBoxSize<HTMLDivElement>();
  const [barRef, bar] = useBoxSize<HTMLDivElement>();

  // Same transparency opt-out the other sources make - see the note in Overlay.css.
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
  // Drives the reveal gate below: names hold until the board has finished being dealt.
  const battlePhase = useBattlePhaseName(state.attacks, room);
  const boardSize = room?.board_size ?? 0;
  const challenges = useMemo(
    () => (room ? challengesForRoom(room.id, boardSize * boardSize, room.square_set, room.seed, room.board_perm) : []),
    [room, boardSize]
  );

  if (!room) return null;
  /**
   * Nothing at all until the match starts.
   *
   * The players' own key (BoardLegend) is a battle-screen element - it isn't on the placement
   * screen, because which colours were dealt is part of the board you're placing blind against.
   * This strip is the same key, so it keeps the same hours. A caster's scene shows an empty lower
   * third for the minute or two of placement, which is the honest picture: there is nothing to
   * read yet.
   */
  if (!squaresRevealed(room.status, battlePhase)) return null;

  const { items, heading } = legendItems(challenges, room.square_set);
  // A set that tints nothing (Ringus) has no key to show. Render nothing at all rather than an
  // empty plate - a bar of background sitting on a stream saying nothing is worse than no source.
  if (items.length === 0) return null;

  // ?plate=0 drops the dark backing for a caster whose scene already has a lower third to sit on.
  const plate = params.get("plate") !== "0";
  // ?label=0 drops the "Regions" / "Colours" caption, for a very short source.
  const showLabel = params.get("label") !== "0";
  // ?opacity= - see readOpacity. Written by the same slider that fades the board.
  const opacity = readOpacity(params);
  // ?text= - written by the same control that sizes the board's square names. See overlayText.
  const textSize = readTextSize(params);

  /**
   * Fill whatever source the streamer made, without them having to guess a size.
   *
   * Same approach as the scorebug: laid out at its natural size, then scaled to fit. That matters
   * more here than anywhere else, because the number of items is set by the room - a board with
   * nine regions on it is half again as wide as one with six, and neither should overflow or leave
   * the strip mostly empty. See fitScale for why it doesn't fit the frame exactly.
   *
   * The streamer's text size raises the ceiling on that fit rather than being applied on top of it,
   * so the source stays the boundary - a key is a strip whose whole job is to span the screen, and
   * one scaled past its own source loses the colours at both ends.
   */
  const scale = fitScale(bar, frame, 8, textSize);

  return (
    <div className="ovk" ref={frameRef}>
      <div
        className={`ovk-bar${plate ? " ovk-plate" : ""}`}
        ref={barRef}
        style={{ transform: `translate(-50%, -50%) scale(${scale})`, opacity }}
      >
        {showLabel && <span className="ovk-label">{heading}</span>}
        {items.map((item) => (
          <span key={item.key} className="ovk-item">
            <span className={`${item.className} ovk-swatch`} style={item.style} aria-hidden />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
