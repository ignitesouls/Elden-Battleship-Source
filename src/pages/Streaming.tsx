import { useEffect, useMemo, useState } from "react";
import { AutoFireSetup } from "../components/AutoFireSetup";
import { OverlaySetting as Setting, textReadout } from "../components/OverlaySetting";
import { OverlaySample } from "../components/OverlaySample";
import { SourceRow } from "../components/SourceRow";
import { SiteFooter } from "../components/SiteFooter";
import { WatchLinkBox } from "../components/WatchLinkBox";
import { useAuthProfile } from "../hooks/useAuthProfile";
import { MIN_OPACITY, MIN_ALERT_SECS, MAX_ALERT_SECS, DEFAULT_ALERT_SECS } from "../lib/overlayCast";
import { MIN_TEXT_SIZE, MAX_TEXT_SIZE } from "../lib/overlayText";
import {
  createOverlayToken,
  fetchOverlayToken,
  maskOverlayToken,
  rotateOverlayToken,
  sourcesFor,
  streamCastUrl,
  streamSourceUrl,
  type SceneKind,
  type SceneSettings,
} from "../lib/streamOverlay";
import { SCENE_CANVAS, buildObsScene, buildCastCollection, castSceneFilename, previewBox, sceneFilename } from "../lib/obsScene";
import {
  screenRects,
  boardRect,
  clockRect,
  castCamRects,
  casterCamRects,
  frac,
  type CastLayoutConfig,
} from "../lib/castSceneLayout";
import { MAX_DELAY_MS } from "../lib/overlayCast";
import type { DeepMark } from "../lib/deepWater";
import "./Streaming.css";

/**
 * Everything a streamer sets up once: the OBS overlay, and auto-marking.
 *
 * -- Why the two are on one page -----------------------------------------------------------------
 *
 * They are the same errand. Both are a permanent per-account token that encodes no room and no match,
 * both are pasted into a program that is not this website, and both are done on the day somebody
 * decides to start streaming this game and then never again. Auto-marking used to live on the
 * profile page, which is where a person goes to look at their own career - a reasonable home for a
 * token and a poor one for a task, because nobody setting up OBS thinks to look at their stats page
 * for it. This is in the top bar next to the bug report, where the things you do rather than read
 * already are.
 *
 * -- What the overlay half is doing --------------------------------------------------------------
 *
 * The old way still works and is still offered, at the bottom, under ADVANCED: copy seven URLs into
 * seven Browser Sources, once per match, forever. This is the other way. The token names the player
 * rather than the room, so one downloaded scene follows them from match to match and the URLs inside
 * it never go stale. See lib/streamOverlay.
 *
 * The scene is an INITIAL arrangement, and the page says so more than once, because the single worst
 * outcome here is somebody spending an evening laying out their scene and then losing it to a
 * re-import. Elden Battleship owns the data; OBS owns the layout.
 */

const DEFAULTS: SceneSettings = {
  opacity: 1,
  textSize: 1,
  emptyFade: 1,
  alertSecs: DEFAULT_ALERT_SECS,
};

/** What OBS will call the scene. One name per audience, so a caster can import both without a clash. */
function sceneName(kind: SceneKind): string {
  return kind === "caster" ? "Elden Battleship (Caster)" : "Elden Battleship";
}

/**
 * A map of the scene, at the proportions it will actually import at.
 *
 * Not a picture of the overlays - the sample above it already is one. This answers the other
 * question, the one a streamer cannot otherwise answer until after they have imported: how much of
 * my screen does all of this cover, and what is left for the game? Every box is drawn at the share of
 * a 1080p canvas its source occupies, from the same placements the generated file is built from, so
 * it cannot drift from what lands in OBS.
 */
function SceneMap({ kind, chosen }: { kind: SceneKind; chosen: Set<string> }) {
  const sources = sourcesFor(kind).filter((s) => chosen.has(s.id));
  return (
    <div className="obs-map" role="img" aria-label="Where each source lands in the scene">
      {sources.map((source) => {
        const box = previewBox(kind, source);
        return (
          <div
            key={source.id}
            className="obs-map-box"
            style={{
              left: `${box.left * 100}%`,
              top: `${box.top * 100}%`,
              width: `${box.width * 100}%`,
              height: `${box.height * 100}%`,
            }}
          >
            <span>{source.label}</span>
          </div>
        );
      })}
      <span className="obs-map-note">
        {SCENE_CANVAS.w} x {SCENE_CANVAS.h} - where each source lands.
      </span>
    </div>
  );
}

/** The casting scene's map: numbered stream boxes, the board, the clock - and the break scene beside it. */
function CastSceneMap({ config }: { config: CastLayoutConfig }) {
  const boxes = screenRects(config);
  const board = boardRect();
  const clock = clockRect();
  const castCams = castCamRects();
  const cams = casterCamRects();
  const box = (r: { x: number; y: number; w: number; h: number }, label: string, key: string) => {
    const f = frac(r);
    return (
      <div
        key={key}
        className="obs-map-box"
        style={{ left: `${f.left * 100}%`, top: `${f.top * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%` }}
      >
        <span>{label}</span>
      </div>
    );
  };
  return (
    <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
      <div className="obs-map" role="img" aria-label="The casting scene">
        {boxes.map((r, i) => box(r, `${i + 1}`, `s${i}`))}
        {box(board, "Board", "board")}
        {box(clock, "Clock", "clock")}
        {castCams.map((r, i) => box(r, i === 0 ? "Caster" : "Co-caster", `cc${i}`))}
        <span className="obs-map-note">EB Cast - {SCENE_CANVAS.w} x {SCENE_CANVAS.h}</span>
      </div>
      <div className="obs-map" role="img" aria-label="The camera-break scene">
        {cams.map((r, i) => box(r, i === 0 ? "Caster" : "Co-caster", `c${i}`))}
        <span className="obs-map-note">EB Casters - the break</span>
      </div>
    </div>
  );
}

/**
 * The casting set scene: a whole broadcast layout in one import, plus a camera-break scene.
 *
 * Its own box rather than a third "who's streaming" option, because it is a different shape of thing
 * - it is not a menu of elements a caster arranges, it is one composed scene keyed to the room's
 * roster. It reuses the same overlay token as the box above.
 */
function CastingSceneBox({ base, token }: { base: string; token: string }) {
  const [teams, setTeams] = useState(2);
  const [perTeam, setPerTeam] = useState(3);
  const [delayMs, setDelayMs] = useState(0);
  const config: CastLayoutConfig = { teams, perTeam };

  function download() {
    const collection = buildCastCollection({ base, token, config, delayMs });
    const blob = new Blob([JSON.stringify(collection, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = castSceneFilename();
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="panel stack" style={{ gap: "0.6rem", padding: "0.7rem" }}>
      <strong style={{ fontSize: "0.86rem" }}>Casting set scene</strong>
      <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
        One import, two scenes: <strong>EB Cast</strong> boxes every player's Twitch stream around
        the board with a live hit / miss / accuracy line under each, and <strong>EB Casters</strong>
        is a camera frame for the breaks. The boxes fill themselves from whoever is in your room.
        Drive it from the caster desk - the delay slider there lines the board up with the streams.
      </span>

      <div className="row" style={{ gap: "0.8rem", flexWrap: "wrap" }}>
        <label className="stack" style={{ gap: "0.15rem", fontSize: "0.74rem" }}>
          Fleets on camera
          <select value={teams} onChange={(e) => setTeams(Number(e.target.value))}>
            {[2, 3, 4].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="stack" style={{ gap: "0.15rem", fontSize: "0.74rem" }}>
          Players per fleet
          <select value={perTeam} onChange={(e) => setPerTeam(Number(e.target.value))}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="stack" style={{ gap: "0.15rem", fontSize: "0.74rem" }}>
          Stream delay
          <span className="row" style={{ gap: "0.4rem", alignItems: "center" }}>
            <input
              type="range"
              min={0}
              max={MAX_DELAY_MS}
              step={100}
              value={delayMs}
              onChange={(e) => setDelayMs(Number(e.target.value))}
            />
            <span className="muted" style={{ fontSize: "0.7rem" }}>{(delayMs / 1000).toFixed(1)}s</span>
          </span>
        </label>
      </div>

      <CastSceneMap config={config} />

      <button onClick={download} style={{ fontSize: "0.82rem" }}>
        Download casting scene
      </button>
      <span style={{ fontSize: "0.68rem", lineHeight: 1.4, color: "var(--hit)" }}>
        <strong>Arrange it after you import.</strong> Same as above - a re-download is a new pair of
        scenes, not an update.
      </span>
      <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
        The player boxes are Twitch embeds, muted and capped to 480p. If one stream drifts, add a
        Render Delay filter to that Screen source in OBS. The caster and co-caster boxes - two along
        the bottom of EB Cast, two big ones in EB Casters - are cut-outs: put your webcams behind
        them.
      </span>
    </div>
  );
}

export function Streaming() {
  /**
   * A Twitch account, or nothing.
   *
   * The same bar auto-marking sets, for the same reason: "permanent" is only true if the identity is.
   * An anonymous session's user id lives in one browser's storage, so a scene built against it stops
   * resolving the moment somebody clears their cache or moves machines - with no error anywhere, in
   * the middle of a stream.
   */
  const viewer = useAuthProfile();
  const signedIn = Boolean(viewer?.isTwitch);

  /** `undefined` while loading, `null` when they have never made one. Mirrors AutoFireSetup. */
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  const [kind, setKind] = useState<SceneKind>("player");
  /** Which sources are ticked. Seeded from each list's own defaults the first time it is shown. */
  const [chosen, setChosen] = useState<Record<SceneKind, Set<string>>>(() => ({
    player: new Set(sourcesFor("player").filter((s) => s.on).map((s) => s.id)),
    caster: new Set(sourcesFor("caster").filter((s) => s.on).map((s) => s.id)),
  }));

  const [opacity, setOpacity] = useState(DEFAULTS.opacity);
  const [emptyFade, setEmptyFade] = useState(DEFAULTS.emptyFade);
  const [textSize, setTextSize] = useState(DEFAULTS.textSize);
  const [alertSecs, setAlertSecs] = useState(DEFAULTS.alertSecs);
  /** A find held over the sample, so the alert slider has something to demonstrate. */
  const [playing, setPlaying] = useState<DeepMark | null>(null);
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setPlaying(null), alertSecs * 1000);
    return () => clearTimeout(t);
  }, [playing, alertSecs]);

  useEffect(() => {
    if (!signedIn) {
      setToken(null);
      return;
    }
    void (async () => {
      try {
        setToken(await fetchOverlayToken());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setToken(null);
      }
    })();
  }, [signedIn]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      setToken(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirmingRotate(false);
    }
  }

  const scene: SceneSettings = { opacity, textSize, emptyFade, alertSecs };
  const isCaster = kind === "caster";
  const picked = chosen[kind];

  // Built from window.location so the URLs stay right on localhost, on GitHub Pages under its
  // /Elden-Battleship/ base, and anywhere else this is hosted. Hardcoding the deployed origin would
  // hand every local tester a scene pointing at production - same reasoning as OverlayLinkBox.
  const base = `${window.location.origin}${window.location.pathname}`;

  const entries = useMemo(
    () =>
      token
        ? sourcesFor(kind)
            .filter((s) => picked.has(s.id))
            .map((source) => ({ source, url: streamSourceUrl(base, source, token, scene, DEFAULTS) }))
        : [],
    // The scene settings are spread rather than passed as an object so a slider actually invalidates
    // this - a fresh `scene` object every render would make the memo pointless in the other direction.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [token, kind, picked, base, opacity, textSize, emptyFade, alertSecs]
  );

  function toggle(id: string) {
    setChosen((prev) => {
      const next = new Set(prev[kind]);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, [kind]: next };
    });
  }

  /**
   * The download.
   *
   * A Blob and an object URL rather than a data: URI, because a scene with seven long URLs in it is
   * comfortably past the length some browsers will accept in an href, and a download that silently
   * does nothing is the worst possible failure for a button like this.
   */
  function download() {
    const collection = buildObsScene({ kind, entries, sceneName: sceneName(kind) });
    const blob = new Blob([JSON.stringify(collection, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sceneFilename(kind);
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="stack obs-page" style={{ gap: "0.9rem" }}>
      <div className="stack" style={{ gap: "0.3rem" }}>
        <h2 style={{ margin: 0 }}>OBS &amp; auto-marking</h2>
        <span className="muted" style={{ fontSize: "0.8rem", lineHeight: 1.45 }}>
          Set both up once. The game mod fires your squares as you kill them; the overlay follows you
          from match to match.
        </span>
      </div>

      {/*
        -- auto-marking, first -----------------------------------------------------------------

        Ahead of the overlay because it is the one with a prerequisite outside this website. It ends
        in "open this file in Notepad and paste", so somebody who has not got Dionysus installed
        needs to find that out at the top of the page rather than after they have built a scene.
        The overlay below needs nothing but OBS, so it can wait its turn.
      */}
      <AutoFireSetup />

      {/* -- the overlay ------------------------------------------------------------------------ */}
      <div className="panel stack" style={{ gap: "0.6rem", padding: "0.7rem" }}>
        <strong style={{ fontSize: "0.86rem" }}>Stream overlay</strong>

        <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
          One download, one import. Each element arrives as its own Browser Source, so you can place
          them separately. The URLs never change - join your next match and the overlay is already
          on it.
        </span>

        {!signedIn ? (
          <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
            Sign in with Twitch first. Without an account you exist only in this browser, so clearing
            your cache would leave your whole scene pointing at nobody.
          </span>
        ) : token === undefined ? null : token === null ? (
          <>
            <button onClick={() => void run(createOverlayToken)} disabled={busy} style={{ fontSize: "0.8rem" }}>
              {busy ? "Setting up..." : "Set up overlay"}
            </button>
            <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
              Makes a read-only token. It can't fire shots, take your seat, or read your account.
            </span>
          </>
        ) : (
          <>
            {/* -- who it is for ------------------------------------------------------------- */}
            <div className="stack" style={{ gap: "0.25rem" }}>
              <span style={{ fontSize: "0.78rem" }}>Who's streaming?</span>
              <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
                <button
                  onClick={() => setKind("player")}
                  style={{ fontSize: "0.74rem", borderColor: !isCaster ? "var(--accent)" : undefined }}
                >
                  Player
                </button>
                <button
                  onClick={() => setKind("caster")}
                  style={{ fontSize: "0.74rem", borderColor: isCaster ? "var(--accent)" : undefined }}
                >
                  Caster
                </button>
              </div>
              <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
                {isCaster
                  ? "The desk: the board you aim from the control page, and the clock with the odds bar in it. Join a room as a spectator and the scene follows you in."
                  : "Your own scene - the board you're playing off, and the clock. Your fleet is filled in when the match starts, so you can change crews without touching anything."}
              </span>
            </div>

            {/* -- the look ------------------------------------------------------------------- */}
            <OverlaySample
              opacity={opacity}
              emptyFade={isCaster ? 1 : emptyFade}
              textSize={textSize}
              alertMark={playing}
              isCaster={isCaster}
            />

            <Setting
              label="Overlay transparency"
              hint="How much of your gameplay shows through the whole scene. On the boards it's the water that fades: square names and shots hold back about halfway to solid, and the frame and grid lines barely move."
              min={MIN_OPACITY}
              max={1}
              step={0.05}
              value={opacity}
              onChange={setOpacity}
              readout={opacity >= 1 ? "solid" : opacity <= 0 ? "hidden" : `${Math.round(opacity * 100)}%`}
            />

            {/* Crews only, for the reason the in-room box gives: a caster is reading the whole board
                and needs the squares nobody has fired at to still be squares. */}
            {!isCaster && (
              <Setting
                label="Unfired squares"
                hint="How solid a square you haven't shot at yet is. Turn it down and your own gameplay shows through everywhere you haven't been, while hits, misses and wrecks stay as solid as ever."
                min={0}
                max={1}
                step={0.05}
                value={emptyFade}
                onChange={setEmptyFade}
                readout={
                  emptyFade >= 1
                    ? "same as the rest"
                    : emptyFade <= 0
                      ? "no fill at all"
                      : `${Math.round(emptyFade * 100)}%`
                }
              />
            )}

            <Setting
              label="Text size"
              hint="How much of each square its name fills, plus the clock and the key. Text never overflows: a size that doesn't fit draws as large as it can."
              min={MIN_TEXT_SIZE}
              max={MAX_TEXT_SIZE}
              step={0.05}
              value={textSize}
              onChange={setTextSize}
              readout={textReadout(textSize)}
            />

            <Setting
              label="Find alert time"
              hint="How long the Finds source holds a find on screen before it goes back to drawing nothing."
              min={MIN_ALERT_SECS}
              max={MAX_ALERT_SECS}
              step={1}
              value={alertSecs}
              onChange={setAlertSecs}
              readout={`${alertSecs}s`}
            />

            <button
              onClick={() => setPlaying(playing ? null : "whale")}
              style={{ fontSize: "0.74rem", alignSelf: "flex-start" }}
              title="Show a sample find over the preview above"
            >
              {playing ? "Stop" : "Play a sample find"}
            </button>

            {/* -- what goes in it ------------------------------------------------------------ */}
            <div className="stack" style={{ gap: "0.3rem" }}>
              <span style={{ fontSize: "0.78rem" }}>Elements</span>
              {sourcesFor(kind).map((source) => (
                <label key={source.id} className="obs-pick">
                  <input type="checkbox" checked={picked.has(source.id)} onChange={() => toggle(source.id)} />
                  <span className="stack" style={{ gap: "0.1rem" }}>
                    <span style={{ fontSize: "0.76rem" }}>
                      {source.label}{" "}
                      <span className="muted" style={{ fontSize: "0.68rem" }}>
                        {source.width} x {source.height}
                      </span>
                    </span>
                    <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
                      {source.note}
                    </span>
                    {/* On the row, not on a toggle elsewhere: the decision is made at the moment the
                        box is ticked, and that is the moment it has to be readable. */}
                    {source.spoiler && picked.has(source.id) && (
                      <span style={{ fontSize: "0.68rem", lineHeight: 1.35, color: "var(--hit)" }}>
                        <strong>
                          This one draws your ships. Put it on stream only if you want viewers to
                          see where your hulls are.
                        </strong>
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>

            <SceneMap kind={kind} chosen={picked} />

            <button onClick={download} disabled={picked.size === 0} style={{ fontSize: "0.82rem" }}>
              Download OBS scene
            </button>

            <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
              In OBS: <strong>Scene Collection - Import</strong>, pick the file, then switch to it.
            </span>

            {/* The one warning on this page that is worth red. Losing an evening's layout to a
                re-import is the worst thing that can happen to somebody using this. */}
            <span style={{ fontSize: "0.68rem", lineHeight: 1.4, color: "var(--hit)" }}>
              <strong>Arrange it after you import, not before.</strong> Downloading again builds a
              new scene, not an update - whatever you moved in OBS is gone.
            </span>

            {isCaster && (
              <div className="stack" style={{ gap: "0.15rem" }}>
                <span style={{ fontSize: "0.78rem" }}>Control page</span>
                <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
                  Open <a href={streamCastUrl(base, token)}>your caster desk</a> in a normal browser
                  window, not in OBS. It drives the Board source - zoom, pan, spotlight, markers, and
                  how solid the scene looks - and it follows you between rooms like the sources do.
                </span>
              </div>
            )}

            {/* -- the advanced half ---------------------------------------------------------- */}
            <details className="stack" style={{ gap: "0.4rem" }}>
              <summary style={{ fontSize: "0.78rem", cursor: "pointer" }}>
                Advanced - individual Browser Sources
              </summary>
              <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
                The same URLs the scene file holds. Use them to build the scene yourself, or to add
                one element to a scene you already have. Paste one in and it never needs changing.
              </span>
              {entries.map(({ source, url }) => (
                <SourceRow
                  key={source.id}
                  label={source.label}
                  url={url}
                  size={`${source.width} x ${source.height}`}
                  note={source.note}
                />
              ))}
            </details>

            {/* -- the token ------------------------------------------------------------------ */}
            <div className="stack" style={{ gap: "0.3rem" }}>
              <span style={{ fontSize: "0.78rem" }}>Your overlay token</span>
              <code className="obs-token">{revealed ? token : maskOverlayToken(token)}</code>
              <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
                <button onClick={() => setRevealed((r) => !r)} style={{ fontSize: "0.74rem" }}>
                  {revealed ? "Hide" : "Reveal"}
                </button>
                {confirmingRotate ? (
                  <>
                    <button
                      onClick={() => void run(rotateOverlayToken)}
                      disabled={busy}
                      style={{ fontSize: "0.74rem", color: "var(--hit)" }}
                    >
                      {busy ? "Rotating..." : "Yes, rotate it"}
                    </button>
                    <button onClick={() => setConfirmingRotate(false)} style={{ fontSize: "0.74rem" }}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button onClick={() => setConfirmingRotate(true)} style={{ fontSize: "0.74rem" }}>
                    Rotate token
                  </button>
                )}
              </div>
              <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
                {confirmingRotate
                  ? "Kills the old token at once: every source in your scene goes blank until you download and import again."
                  : "There's nothing to paste anywhere - it's already inside the scene file. Masked because people screenshot this page; rotate it if it leaks, then import the scene again."}
              </span>
            </div>
          </>
        )}

        {error && (
          <span style={{ fontSize: "0.72rem", color: "var(--hit)" }} role="alert">
            {error}
          </span>
        )}

        <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
          Want a scene for one particular room? The <strong>Stream overlay</strong> box inside a room
          hands out URLs for that room alone.
        </span>
      </div>

      {/* The casting set scene - a whole broadcast layout, for whoever is running the desk. Needs
          the same overlay token as the box above. */}
      {signedIn && typeof token === "string" && <CastingSceneBox base={base} token={token} />}

      {/*
        -- the audience, last -------------------------------------------------------------------

        After the overlay rather than before it, because it is the only thing on this page that is
        not about the streamer's own screen. The first two boxes end with something pasted into OBS
        or into a config file; this one ends with something pasted into Twitch, which is the next
        thing they do and not the same thing.
      */}
      <WatchLinkBox />

      <SiteFooter />
    </div>
  );
}
