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
import { useT } from "../lib/language";
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
  const t = useT();
  const sources = sourcesFor(kind).filter((s) => chosen.has(s.id));
  return (
    <div className="obs-map" role="img" aria-label={t("Where each source lands in the scene", "Où chaque source se place dans la scène")}>
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
        {SCENE_CANVAS.w} x {SCENE_CANVAS.h} {t("- where each source lands.", "- où chaque source se place.")}
      </span>
    </div>
  );
}

/** The casting scene's map: numbered stream boxes, the board, the clock - and the break scene beside it. */
function CastSceneMap({ config }: { config: CastLayoutConfig }) {
  const t = useT();
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
      <div className="obs-map" role="img" aria-label={t("The casting scene", "La scène de commentaire")}>
        {boxes.map((r, i) => box(r, `${i + 1}`, `s${i}`))}
        {box(board, t("Board", "Plateau"), "board")}
        {box(clock, t("Clock", "Horloge"), "clock")}
        {castCams.map((r, i) => box(r, i === 0 ? t("Caster", "Commentateur") : t("Co-caster", "Co-commentateur"), `cc${i}`))}
        <span className="obs-map-note">EB Cast - {SCENE_CANVAS.w} x {SCENE_CANVAS.h}</span>
      </div>
      <div className="obs-map" role="img" aria-label={t("The camera-break scene", "La scène de pause caméra")}>
        {cams.map((r, i) => box(r, i === 0 ? t("Caster", "Commentateur") : t("Co-caster", "Co-commentateur"), `c${i}`))}
        <span className="obs-map-note">EB Casters - {t("the break", "la pause")}</span>
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
  const t = useT();
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
      <strong style={{ fontSize: "0.86rem" }}>{t("Casting set scene", "Ensemble de scènes de commentaire")}</strong>
      <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
        {t("One import, two scenes:", "Un import, deux scènes :")} <strong>EB Cast</strong>{" "}
        {t(
          "boxes every player's Twitch stream around the board with a live hit / miss / accuracy line under each, and",
          "encadre le flux Twitch de chaque joueur autour du plateau avec une ligne touché / manqué / précision en direct sous chacun, et"
        )}{" "}
        <strong>EB Casters</strong>{" "}
        {t(
          "is a camera frame for the breaks. The boxes fill themselves from whoever is in your room. Drive it from the caster desk - the delay slider there lines the board up with the streams.",
          "est un cadre caméra pour les pauses. Les cadres se remplissent tout seuls selon qui est dans votre partie. Pilotez-le depuis le poste de commentaire - le curseur de décalage là-bas aligne le plateau sur les flux."
        )}
      </span>

      <div className="row" style={{ gap: "0.8rem", flexWrap: "wrap" }}>
        <label className="stack" style={{ gap: "0.15rem", fontSize: "0.74rem" }}>
          {t("Fleets on camera", "Flottes à l'écran")}
          <select value={teams} onChange={(e) => setTeams(Number(e.target.value))}>
            {[2, 3, 4].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="stack" style={{ gap: "0.15rem", fontSize: "0.74rem" }}>
          {t("Players per fleet", "Joueurs par flotte")}
          <select value={perTeam} onChange={(e) => setPerTeam(Number(e.target.value))}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="stack" style={{ gap: "0.15rem", fontSize: "0.74rem" }}>
          {t("Stream delay", "Décalage du flux")}
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
        {t("Download casting scene", "Télécharger la scène de commentaire")}
      </button>
      <span style={{ fontSize: "0.68rem", lineHeight: 1.4, color: "var(--hit)" }}>
        <strong>{t("Arrange it after you import.", "Disposez-la après l'import.")}</strong>{" "}
        {t("Same as above - a re-download is a new pair of scenes, not an update.", "Comme ci-dessus - un nouveau téléchargement crée une nouvelle paire de scènes, pas une mise à jour.")}
      </span>
      <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
        {t(
          "The player boxes are Twitch embeds, muted and capped to 480p. If one stream drifts, add a Render Delay filter to that Screen source in OBS. The caster and co-caster boxes - two along the bottom of EB Cast, two big ones in EB Casters - are cut-outs: put your webcams behind them.",
          "Les cadres joueurs sont des flux Twitch intégrés, muets et limités à 480p. Si un flux se décale, ajoutez un filtre Render Delay à cette source Screen dans OBS. Les cadres commentateur et co-commentateur - deux en bas d'EB Cast, deux grands dans EB Casters - sont des découpes : placez vos webcams derrière."
        )}
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
  const t = useT();
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
        <h2 style={{ margin: 0 }}>{t("OBS & auto-marking", "OBS et marquage automatique")}</h2>
        <span className="muted" style={{ fontSize: "0.8rem", lineHeight: 1.45 }}>
          {t(
            "Set both up once. The game mod fires your squares as you kill them; the overlay follows you from match to match.",
            "Configurez les deux une fois. Le mod du jeu tire vos cases à mesure que vous tuez ; l'overlay vous suit de partie en partie."
          )}
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
        <strong style={{ fontSize: "0.86rem" }}>{t("Stream overlay", "Overlay de stream")}</strong>

        <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
          {t(
            "One download, one import. Each element arrives as its own Browser Source, so you can place them separately. The URLs never change - join your next match and the overlay is already on it.",
            "Un téléchargement, un import. Chaque élément arrive comme sa propre Browser Source, pour les placer séparément. Les URL ne changent jamais - rejoignez votre prochaine partie et l'overlay y est déjà."
          )}
        </span>

        {!signedIn ? (
          <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
            {t(
              "Sign in with Twitch first. Without an account you exist only in this browser, so clearing your cache would leave your whole scene pointing at nobody.",
              "Connectez-vous d'abord avec Twitch. Sans compte, vous n'existez que dans ce navigateur, donc vider votre cache laisserait toute votre scène pointer vers personne."
            )}
          </span>
        ) : token === undefined ? null : token === null ? (
          <>
            <button onClick={() => void run(createOverlayToken)} disabled={busy} style={{ fontSize: "0.8rem" }}>
              {busy ? t("Setting up...", "Configuration...") : t("Set up overlay", "Configurer l'overlay")}
            </button>
            <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
              {t(
                "Makes a read-only token. It can't fire shots, take your seat, or read your account.",
                "Crée un jeton en lecture seule. Il ne peut pas tirer, prendre votre place, ni lire votre compte."
              )}
            </span>
          </>
        ) : (
          <>
            {/* -- who it is for ------------------------------------------------------------- */}
            <div className="stack" style={{ gap: "0.25rem" }}>
              <span style={{ fontSize: "0.78rem" }}>{t("Who's streaming?", "Qui diffuse ?")}</span>
              <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
                <button
                  onClick={() => setKind("player")}
                  style={{ fontSize: "0.74rem", borderColor: !isCaster ? "var(--accent)" : undefined }}
                >
                  {t("Player", "Joueur")}
                </button>
                <button
                  onClick={() => setKind("caster")}
                  style={{ fontSize: "0.74rem", borderColor: isCaster ? "var(--accent)" : undefined }}
                >
                  {t("Caster", "Commentateur")}
                </button>
              </div>
              <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
                {isCaster
                  ? t(
                      "The desk: the board you aim from the control page, and the clock with the odds bar in it. Join a room as a spectator and the scene follows you in.",
                      "Le poste : le plateau que vous visez depuis la page de contrôle, et l'horloge avec la barre de cotes. Rejoignez une partie en spectateur et la scène vous suit."
                    )
                  : t(
                      "Your own scene - the board you're playing off, and the clock. Your fleet is filled in when the match starts, so you can change crews without touching anything.",
                      "Votre propre scène - le plateau sur lequel vous jouez, et l'horloge. Votre flotte se remplit au début de la partie, vous pouvez donc changer d'équipe sans rien toucher."
                    )}
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
              label={t("Overlay transparency", "Transparence de l'overlay")}
              hint={t(
                "How much of your gameplay shows through the whole scene. On the boards it's the water that fades: square names and shots hold back about halfway to solid, and the frame and grid lines barely move.",
                "Combien de votre gameplay transparaît dans toute la scène. Sur les plateaux, c'est l'eau qui s'efface : les noms de cases et les tirs restent à peu près à mi-chemin du plein, et le cadre et les lignes de grille bougent à peine."
              )}
              min={MIN_OPACITY}
              max={1}
              step={0.05}
              value={opacity}
              onChange={setOpacity}
              readout={opacity >= 1 ? t("solid", "plein") : opacity <= 0 ? t("hidden", "invisible") : `${Math.round(opacity * 100)}%`}
            />

            {/* Crews only, for the reason the in-room box gives: a caster is reading the whole board
                and needs the squares nobody has fired at to still be squares. */}
            {!isCaster && (
              <Setting
                label={t("Unfired squares", "Cases non tirées")}
                hint={t(
                  "How solid a square you haven't shot at yet is. Turn it down and your own gameplay shows through everywhere you haven't been, while hits, misses and wrecks stay as solid as ever.",
                  "À quel point une case sur laquelle vous n'avez pas encore tiré est pleine. Baissez-la et votre propre gameplay transparaît partout où vous n'êtes pas allé, tandis que touchés, manqués et épaves restent tout aussi pleins."
                )}
                min={0}
                max={1}
                step={0.05}
                value={emptyFade}
                onChange={setEmptyFade}
                readout={
                  emptyFade >= 1
                    ? t("same as the rest", "comme le reste")
                    : emptyFade <= 0
                      ? t("no fill at all", "aucun remplissage")
                      : `${Math.round(emptyFade * 100)}%`
                }
              />
            )}

            <Setting
              label={t("Text size", "Taille du texte")}
              hint={t(
                "How much of each square its name fills, plus the clock and the key. Text never overflows: a size that doesn't fit draws as large as it can.",
                "Quelle part de chaque case son nom remplit, ainsi que l'horloge et la légende. Le texte ne dépasse jamais : une taille qui ne rentre pas se dessine aussi grande que possible."
              )}
              min={MIN_TEXT_SIZE}
              max={MAX_TEXT_SIZE}
              step={0.05}
              value={textSize}
              onChange={setTextSize}
              readout={textReadout(textSize)}
            />

            <Setting
              label={t("Find alert time", "Durée d'alerte de découverte")}
              hint={t(
                "How long the Finds source holds a find on screen before it goes back to drawing nothing.",
                "Combien de temps la source Finds garde une découverte à l'écran avant de redessiner le vide."
              )}
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
              title={t("Show a sample find over the preview above", "Afficher une découverte d'exemple sur l'aperçu ci-dessus")}
            >
              {playing ? t("Stop", "Arrêter") : t("Play a sample find", "Jouer une découverte d'exemple")}
            </button>

            {/* -- what goes in it ------------------------------------------------------------ */}
            <div className="stack" style={{ gap: "0.3rem" }}>
              <span style={{ fontSize: "0.78rem" }}>{t("Elements", "Éléments")}</span>
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
                          {t(
                            "This one draws your ships. Put it on stream only if you want viewers to see where your hulls are.",
                            "Celle-ci dessine vos navires. Ne la mettez en stream que si vous voulez que les spectateurs voient où sont vos coques."
                          )}
                        </strong>
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>

            <SceneMap kind={kind} chosen={picked} />

            <button onClick={download} disabled={picked.size === 0} style={{ fontSize: "0.82rem" }}>
              {t("Download OBS scene", "Télécharger la scène OBS")}
            </button>

            <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
              {t("In OBS:", "Dans OBS :")} <strong>{t("Scene Collection - Import", "Collection de scènes - Importer")}</strong>
              {t(", pick the file, then switch to it.", ", choisissez le fichier, puis basculez dessus.")}
            </span>

            {/* The one warning on this page that is worth red. Losing an evening's layout to a
                re-import is the worst thing that can happen to somebody using this. */}
            <span style={{ fontSize: "0.68rem", lineHeight: 1.4, color: "var(--hit)" }}>
              <strong>{t("Arrange it after you import, not before.", "Disposez-la après l'import, pas avant.")}</strong>{" "}
              {t(
                "Downloading again builds a new scene, not an update - whatever you moved in OBS is gone.",
                "Télécharger à nouveau crée une nouvelle scène, pas une mise à jour - tout ce que vous avez déplacé dans OBS est perdu."
              )}
            </span>

            {isCaster && (
              <div className="stack" style={{ gap: "0.15rem" }}>
                <span style={{ fontSize: "0.78rem" }}>{t("Control page", "Page de contrôle")}</span>
                <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
                  {t("Open", "Ouvrez")} <a href={streamCastUrl(base, token)}>{t("your caster desk", "votre poste de commentaire")}</a>{" "}
                  {t(
                    "in a normal browser window, not in OBS. It drives the Board source - zoom, pan, spotlight, markers, and how solid the scene looks - and it follows you between rooms like the sources do.",
                    "dans une fenêtre de navigateur normale, pas dans OBS. Il pilote la source Board - zoom, panoramique, projecteur, marqueurs, et la transparence de la scène - et il vous suit d'une partie à l'autre comme les autres sources."
                  )}
                </span>
              </div>
            )}

            {/* -- the advanced half ---------------------------------------------------------- */}
            <details className="stack" style={{ gap: "0.4rem" }}>
              <summary style={{ fontSize: "0.78rem", cursor: "pointer" }}>
                {t("Advanced - individual Browser Sources", "Avancé - sources navigateur individuelles")}
              </summary>
              <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
                {t(
                  "The same URLs the scene file holds. Use them to build the scene yourself, or to add one element to a scene you already have. Paste one in and it never needs changing.",
                  "Les mêmes URL que contient le fichier de scène. Utilisez-les pour construire la scène vous-même, ou pour ajouter un élément à une scène que vous avez déjà. Collez-en une et elle n'a plus jamais besoin de changer."
                )}
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
              <span style={{ fontSize: "0.78rem" }}>{t("Your overlay token", "Votre jeton d'overlay")}</span>
              <code className="obs-token">{revealed ? token : maskOverlayToken(token)}</code>
              <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
                <button onClick={() => setRevealed((r) => !r)} style={{ fontSize: "0.74rem" }}>
                  {revealed ? t("Hide", "Masquer") : t("Reveal", "Révéler")}
                </button>
                {confirmingRotate ? (
                  <>
                    <button
                      onClick={() => void run(rotateOverlayToken)}
                      disabled={busy}
                      style={{ fontSize: "0.74rem", color: "var(--hit)" }}
                    >
                      {busy ? t("Rotating...", "Rotation...") : t("Yes, rotate it", "Oui, le régénérer")}
                    </button>
                    <button onClick={() => setConfirmingRotate(false)} style={{ fontSize: "0.74rem" }}>
                      {t("Cancel", "Annuler")}
                    </button>
                  </>
                ) : (
                  <button onClick={() => setConfirmingRotate(true)} style={{ fontSize: "0.74rem" }}>
                    {t("Rotate token", "Régénérer le jeton")}
                  </button>
                )}
              </div>
              <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
                {confirmingRotate
                  ? t(
                      "Kills the old token at once: every source in your scene goes blank until you download and import again.",
                      "Annule le jeton actuel immédiatement : toutes les sources de votre scène deviennent vides jusqu'à ce que vous retéléchargiez et réimportiez."
                    )
                  : t(
                      "There's nothing to paste anywhere - it's already inside the scene file. Masked because people screenshot this page; rotate it if it leaks, then import the scene again.",
                      "Il n'y a rien à coller nulle part - il est déjà dans le fichier de scène. Masqué parce que les gens font des captures d'écran de cette page ; régénérez-le s'il fuite, puis réimportez la scène."
                    )}
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
          {t("Want a scene for one particular room? The", "Vous voulez une scène pour une seule partie ? La boîte")}{" "}
          <strong>{t("Stream overlay", "Overlay de stream")}</strong>{" "}
          {t("box inside a room hands out URLs for that room alone.", "à l'intérieur d'une partie distribue des URL pour cette partie uniquement.")}
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
