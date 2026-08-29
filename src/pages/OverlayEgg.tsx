import { useEffect, useMemo, useRef, useState } from "react";
import { useOverlaySource, type OverlaySourceProps } from "../hooks/useOverlaySource";
import { useRoom } from "../hooks/useRoom";
import { groupIntoShots } from "../lib/attackFeed";
import { deepWater, finalFinds, type DeepFindRow } from "../lib/deepWater";
import { freshDeepEvents } from "../lib/deepQueue";
import { igonAnchor } from "../lib/challenges";
import { cellLabel } from "../lib/battleshipLogic";
import { readOpacity, readAlertSecs } from "../lib/overlayCast";
import { FindCard } from "../components/FindCard";
import "./Overlay.css";
import "./OverlayEgg.css";

/**
 * The finds, as a stream alert - an OBS Browser Source that is empty until the water gives
 * something up, then holds it on screen for a few seconds and goes back to nothing.
 *
 * -- Why this draws the same animations the board does, and not a video ---------------------------
 *
 * The obvious build is eight clips exported from something and played on a cue. It would be worse
 * in four ways, and this is the note that stops somebody rebuilding it that way later:
 *
 *   Alpha. MP4/H.264 has none. Transparent video means VP9-in-WebM with yuva420p, which constrains
 *   whatever produces the clips and is the usual reason an alert arrives with a grey box round it.
 *
 *   Size. These are vector. The same whale is correct in a 90px board square and in an 800px alert,
 *   and correct again on whatever a streamer resizes the source to. A clip is baked at one size and
 *   goes soft everywhere else.
 *
 *   Weight. Eight clips at a few MB each is tens of megabytes committed to a repo whose deploy
 *   target is the Pages root, to reproduce something the browser already draws.
 *
 *   Drift. There would then be two whales - the one on the board and the one in the alert - and one
 *   of them would get improved.
 *
 * So the alert mounts the very same component the board's squares mount (see HitMarkers), inside a
 * box that is simply larger. The marks are positioned in percentages against their container, so
 * scaling them is a matter of giving them a bigger container and nothing else. Their entry
 * animations - whale-surface, jar-arrive, igon-rise - run on mount, which is exactly the cue an
 * alert wants, and their idle ones keep going while it sits there.
 *
 * -- What it shows and to whom -------------------------------------------------------------------
 *
 * Every crew's finds, to whoever has it on screen. Same call as the audio source, and for the same
 * reason: a find belongs to the SEA rather than to any one fleet, the board source already draws
 * the whole room's, and an alert that held some of them back would mean a stream where the board
 * shows a whale and the alert doesn't.
 *
 *     ?secs=8            how long a find holds the screen (2-30, default 6) - see readAlertSecs
 *     ?opacity=0.5       see-through, so gameplay reads under it
 *
 * There is deliberately no ?team=. Nothing here is anybody's secret - it is all derived from the
 * public shot log, exactly as the marks on the board are.
 */
export function OverlayEgg(props: OverlaySourceProps = {}) {
  // The room and the query string come from the URL, or from the persistent stream route that has
  // resolved them off an overlay token. See hooks/useOverlaySource for why this page takes props.
  const { code, params } = useOverlaySource(props);
  const state = useRoom(code);

  // Same opt-out every overlay route makes - see the note in pages/Overlay.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  const secs = readAlertSecs(params);
  const opacity = readOpacity(params);

  const room = state.room;
  /**
   * Every find the match has turned up, oldest first, each carrying the mark its square wears.
   *
   * `finalFinds` rather than `deepMarks` because an alert has a caption: this is the one flattening
   * that keeps the finder's name and fleet alongside the square, and it is the same list the recap
   * and the record book are built from - so the alert cannot name a find something the archive
   * later calls something else.
   */
  const rows: DeepFindRow[] = useMemo(
    () =>
      room
        ? finalFinds(deepWater(room, groupIntoShots(state.attacks, state.players), state.deepHides, igonAnchor(room)))
        : [],
    [room, state.attacks, state.players, state.deepHides]
  );

  /** What has already been shown. Null until the first pass has primed it - see freshDeepEvents. */
  const shown = useRef<Set<string> | null>(null);
  const [queue, setQueue] = useState<DeepFindRow[]>([]);
  const [current, setCurrent] = useState<DeepFindRow | null>(null);

  useEffect(() => {
    // Priming, collapsing a wake to one event and putting headlines first all live in lib/deepQueue,
    // which the sound source reads too - so a stream cannot show a whale the speakers never mention.
    const { fresh, keys } = freshDeepEvents(
      rows.map((r) => ({ cell: r.find.cellIndex, mark: r.mark, item: r })),
      shown.current
    );
    shown.current = keys;
    if (fresh.length === 0) return;
    setQueue((q) => [...q, ...fresh]);
    // Memoised above, so this runs when the log moves rather than on every render - which matters
    // here in a way it doesn't for the sound: this component re-renders on its own timer as each
    // alert comes and goes, and an unmemoised list would rebuild the whole hunt on every tick of it.
  }, [rows]);

  /** One at a time, in order. The timer is the only thing that ends a showing. */
  useEffect(() => {
    if (current !== null || queue.length === 0) return;
    setCurrent(queue[0]);
    setQueue((q) => q.slice(1));
  }, [current, queue]);

  useEffect(() => {
    if (current === null) return;
    const t = setTimeout(() => setCurrent(null), secs * 1000);
    return () => clearTimeout(t);
  }, [current, secs]);

  // Nothing found, nothing on screen. A browser source drawing an empty box would be a rectangle
  // of nothing parked in a scene for the whole match.
  if (!room || current === null) return null;

  const { find, mark } = current;
  const who = find.who;
  const where = cellLabel(find.cellIndex, room.board_size);

  return (
    <div className="ove-frame" style={{ opacity }}>
      {/* Keyed by the find, so a second alert re-mounts the icon rather than swapping the artwork
          inside a box that is already on screen. The entry animations are the cue - without a
          remount the second whale would simply appear, mid-bob, having never surfaced. */}
      <FindCard key={`${find.cellIndex}:${mark}:${find.at}`} mark={mark} who={who} team={find.attackerTeam} where={where} />
    </div>
  );
}
