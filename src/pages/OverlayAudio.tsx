import { useEffect, useMemo, useRef, useState } from "react";
import { useOverlaySource, type OverlaySourceProps } from "../hooks/useOverlaySource";
import { useRoom } from "../hooks/useRoom";
import { useBattlePhaseName, usePauseInfo } from "../hooks/useBattlePhase";
import { useSpectatorSfx } from "../hooks/useSpectatorSfx";
import { groupIntoShots } from "../lib/attackFeed";
import { deepWater, deepMarks } from "../lib/deepWater";
import { igonAnchor } from "../lib/challenges";
import { playSfx, setVolumeOverride, onAudioBlocked, primeAudio } from "../lib/sfx";
import "./OverlayAudio.css";

/**
 * The board, as sound and nothing else - an OBS Browser Source with no picture in it.
 *
 * -- Why this is a source rather than a setting on the others ---------------------------------
 *
 * All four existing overlays are silent, and the only place the game makes a noise is a page with a
 * fleet or a spectator's seat on it (see pages/Room). So a stream carried the match's pictures and
 * none of its sound: a whale surfacing, the sleeper waking, Igon getting to his feet - the moments
 * the whole hunt exists for - reached the viewers as a square quietly changing colour.
 *
 * Bolting the audio onto the board source instead would have tied the two together in exactly the
 * ways a scene needs them apart. A caster wants the board on one monitor's scene and the sound
 * riding under a camera scene; a player wants the audio at a level that sits below their own voice,
 * which is a fader, not a URL. Its own source means OBS's own mixer does that job - tick "Control
 * audio via OBS" in the source's properties and it gets a channel, a fader and a mute button like
 * anything else.
 *
 * It also means the sound is not tied to a picture being VISIBLE. A scene that hides the board
 * during a break can keep the room audible, and one that shows the board over gameplay footage can
 * mute it, without either decision moving the other.
 *
 * -- One source, both audiences ---------------------------------------------------------------
 *
 * There is no caster version and player version of this. It plays every crew's finds to whoever is
 * listening, which is what the board source already DRAWS - a player's own pinned board shows the
 * whole room's finds too (see OverlayBoard, and `deepMarks` with no team). Audio that held some of
 * them back would have meant a stream where the picture shows a whale and the sound doesn't, which
 * is worse than either choice made consistently.
 *
 * `?team=N` is therefore not a filter. It settles exactly one thing - which sting plays at the end -
 * and a source with no team gets the caster's answer to that question.
 */
export function OverlayAudio(props: OverlaySourceProps = {}) {
  // The room and the query string come from the URL, or from the persistent stream route that has
  // resolved them off an overlay token. See hooks/useOverlaySource for why this page takes props.
  const { code, params } = useOverlaySource(props);
  const state = useRoom(code);

  /**
   * How loud, from the URL - because in an OBS Browser Source there is no other way to say it.
   *
   * The app's volume slider lives in the top bar, which every overlay route deliberately doesn't
   * render, and it stores its answer in a browser nobody is sitting at. So the level has to travel
   * in the thing the streamer actually pastes. See setVolumeOverride for why it stays in memory.
   *
   * Cleared on unmount so this can never leak into another page sharing the module - which in OBS,
   * where every browser source runs out of one profile, is not hypothetical.
   */
  const vol = params.get("vol");
  useEffect(() => {
    setVolumeOverride(vol !== null && vol !== "" ? Number(vol) : null);
    return () => setVolumeOverride(null);
  }, [vol]);

  /**
   * Whether the browser will let us make a noise at all.
   *
   * OBS normally starts its browser with autoplay allowed, so this is usually settled before
   * anything happens. But it is a per-install setting a streamer can have turned off, and the
   * failure mode without this check is the worst kind: a source that looks connected, reports no
   * error, and is simply mute for a whole match. So the page asks the question up front, at zero
   * volume, and says so on screen if the answer is no.
   */
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    void primeAudio().then((ok) => setBlocked(!ok));
    // A later rejection counts too: the probe can pass on a source that is then reloaded into a
    // stricter policy, and the badge should tell the truth about the sound that just didn't play.
    onAudioBlocked(() => setBlocked(true));
    return () => onAudioBlocked(null);
  }, []);

  /**
   * Clearing the badge takes a real gesture, which in OBS means the Interact window.
   *
   * The click itself is what lifts the browser's autoplay block, so this handler does not need to do
   * anything except exist and let the probe run again.
   */
  const unblock = () => {
    void primeAudio().then((ok) => setBlocked(!ok));
  };

  const room = state.room;
  const attacks = state.attacks;
  const players = state.players;
  const deepHides = state.deepHides;

  // Every hook below this line runs on every render, room or no room - there is no early return in
  // this component for exactly that reason. A page that mounts before the room has loaded, which is
  // every page, must not change the number of hooks it calls once it arrives.
  const battlePhase = useBattlePhaseName(attacks, room);
  const pause = usePauseInfo(room);

  /**
   * Everything in the water, for whoever is listening - see the note on both audiences above.
   *
   * Memoised on the same inputs the room's own copy uses, because `useSpectatorSfx` keys its
   * seen-set on the identity of this map: a fresh map every render would still work, but it would
   * re-walk the whole log on every realtime tick of a busy match, on a machine that is also encoding
   * a stream.
   */
  const deep = useMemo(
    () => (room ? deepWater(room, groupIntoShots(attacks, players), deepHides, igonAnchor(room)) : null),
    [room, attacks, players, deepHides]
  );
  const deepCells = useMemo(() => (deep ? deepMarks(deep) : undefined), [deep]);

  // Every shot in the room, one sound per trigger-pull, plus whatever the water gives up. This is
  // the same hook the spectator's seat uses and for the same reason - see useSpectatorSfx.
  useSpectatorSfx(attacks, true, deepCells);

  /**
   * The horns, the pause chime and the final sting - everything that is about the MATCH rather than
   * about a square, which useSpectatorSfx deliberately knows nothing about.
   *
   * Each is gated on having seen a previous value, so a source that starts mid-match, or is
   * reloaded, opens quietly instead of blasting a horn at a stream that is already running. That is
   * the same rule pages/Room follows, and it matters more here: an OBS source is restarted by
   * things a player never does to a tab - switching scenes, with "Shutdown source when not visible"
   * ticked, restarts it every time.
   */
  const status = room?.status ?? null;
  const prevStatus = useRef<string | null>(null);
  useEffect(() => {
    if (status === "battle" && prevStatus.current !== null && prevStatus.current !== "battle") {
      playSfx("prepare");
    }
    prevStatus.current = status;
  }, [status]);

  // Preparation is over and the clock starts counting up. Its own effect and its own ref, exactly as
  // in pages/Room: two effects sharing one ref would depend on the order React ran them in.
  const prevPhase = useRef<string | null>(null);
  useEffect(() => {
    if (battlePhase === "match" && prevPhase.current !== null && prevPhase.current !== "match") {
      playSfx("prepare");
    }
    prevPhase.current = battlePhase;
  }, [battlePhase]);

  /**
   * The pause, on both of its edges - see the long note in PauseControls for why the chime opens the
   * stopping countdown and the horn closes the resuming one.
   *
   * Taken from the room's own pause fields rather than from the banner component, which this page
   * has no reason to render. The one thing NOT carried over is the request chime: somebody asking
   * for a pause is a message to the host, not to an audience, and a viewer has no idea what it
   * means.
   */
  const pausePhase = pause.phase;
  const prevPausePhase = useRef<string | null>(null);
  useEffect(() => {
    const from = prevPausePhase.current;
    prevPausePhase.current = pausePhase;
    if (from === null || from === pausePhase) return;
    if (pausePhase === "pausing") playSfx("pause");
    if (pausePhase === "running" && from === "resuming") playSfx("prepare");
  }, [pausePhase]);

  /**
   * The fanfare or the sting, once, on the moment the last fleet goes down.
   *
   * `?team=N` picks which, and it is the only thing that parameter does on this page. Without one,
   * this is a caster's source and takes the spectator's answer from pages/Room: somebody being left
   * standing is the interesting fact, so the fanfare plays - except on a draw, which nobody won.
   */
  const rawTeam = params.get("team");
  const myTeam = rawTeam !== null && rawTeam !== "" && Number.isInteger(Number(rawTeam)) ? Number(rawTeam) : null;
  const winnerTeam = room?.winner_team ?? null;
  const prevStatusForResult = useRef<string | null>(null);
  useEffect(() => {
    if (status === "finished" && prevStatusForResult.current !== null && prevStatusForResult.current !== "finished") {
      const lost = winnerTeam === null || (myTeam !== null && winnerTeam !== myTeam);
      playSfx(lost ? "defeat" : "victory");
    }
    prevStatusForResult.current = status;
  }, [status, winnerTeam, myTeam]);

  /**
   * Nothing on screen, unless something is wrong.
   *
   * A source with no picture is the whole point, and OBS will happily size it 1x1. The badge is the
   * exception, on the same grounds the board source shows its disconnected warning on stream: a
   * silent audio source looks identical to a working one, and the person who can fix it is the one
   * looking at the preview.
   */
  return blocked ? (
    <button type="button" className="ova-blocked" onClick={unblock}>
      Board audio is blocked - right-click this source in OBS, choose Interact, and click here once.
    </button>
  ) : null;
}
