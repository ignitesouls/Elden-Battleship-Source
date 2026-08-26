import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { groupIntoShots } from "../lib/attackFeed";
import { deepWater, finalFinds, type DeepFindRow } from "../lib/deepWater";
import { alertLabel, isHeadline } from "../lib/deepLabels";
import { igonAnchor } from "../lib/challenges";
import { cellLabel } from "../lib/battleshipLogic";
import { readOpacity, readAlertSecs } from "../lib/overlayCast";
import { teamHex } from "../lib/teamColors";
import { DeepMarkIcon } from "../components/HitMarkers";
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
export function OverlayEgg() {
  const { code } = useParams<{ code: string }>();
  const [params] = useSearchParams();
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

  /**
   * What has already been shown. Null until the first pass has primed it.
   *
   * Keyed by square AND mark, which is the rule everything watching the water uses - the four
   * squares turning from "tentacle" to "sleeper" the moment he wakes are news, not squares already
   * seen. Stated here rather than shared with useSpectatorSfx because the two want the same rule
   * and different POLICIES: sound plays one find and drops the rest, since three noises at once is
   * a mess, while this queues them, since three alerts at once is three alerts.
   */
  const shown = useRef<Set<string> | null>(null);
  const [queue, setQueue] = useState<DeepFindRow[]>([]);
  const [current, setCurrent] = useState<DeepFindRow | null>(null);

  useEffect(() => {
    const key = (r: DeepFindRow) => `${r.find.cellIndex}:${r.mark}`;
    const before = shown.current;
    shown.current = new Set(rows.map(key));
    // First pass primes only, so a source added to a scene mid-match doesn't replay the whole hunt
    // into the corner of somebody's stream. Same guard the sound makes.
    if (!before) return;
    const fresh = rows.filter((r) => !before.has(key(r)));
    if (fresh.length === 0) return;

    /**
     * One alert per EVENT, not per square.
     *
     * Cthulhu waking is the case that forces this and the reason it is worth the paragraph. He wakes
     * by turning every tentacle already found from "tentacle" to "sleeper" at once, so a tick that
     * looks like four fresh finds is one thing happening - and queued naively it played as four
     * consecutive alerts, all captioned the same, for half a minute, while the sound source played
     * a single sting. The alert has to say what the sound says.
     *
     * The LAST of a collapsed group wins rather than the first. `rows` is oldest first, so for the
     * wake that is the crew who fired the shot that woke him, which is whose name belongs on it -
     * the three who found tentacles earlier were credited when they did.
     */
    const perMark = new Map<string, DeepFindRow>();
    for (const r of fresh) perMark.set(r.mark, r);
    // Headline finds go to the front of the queue rather than winning outright: nothing gets
    // dropped here - there is time to show both - but the sleeper waking should not sit behind an
    // ordinary find that landed in the same tick. See isHeadline, which the sound shares.
    const ordered = [...perMark.values()].sort(
      (a, b) => Number(isHeadline(b.mark)) - Number(isHeadline(a.mark))
    );
    setQueue((q) => [...q, ...ordered]);
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
      <div className="ove-card" key={`${find.cellIndex}:${mark}:${find.at}`}>
        <div className="ove-art">
          <DeepMarkIcon mark={mark} />
        </div>
        <div className="ove-words">
          <div className="ove-what">{alertLabel(mark)}</div>
          <div className="ove-who">
            <span style={{ color: teamHex(find.attackerTeam) }}>{who}</span>
            <span className="ove-where">{where}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
