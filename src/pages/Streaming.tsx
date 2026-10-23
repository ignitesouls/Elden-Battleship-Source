import { useEffect, useMemo, useState } from "react";
import { AutoFireSetup } from "../components/AutoFireSetup";
import { OverlaySetting as Setting, textReadout } from "../components/OverlaySetting";
import { OverlaySample } from "../components/OverlaySample";
import { SourceRow } from "../components/SourceRow";
import { SiteFooter } from "../components/SiteFooter";
import { WatchLinkBox } from "../components/WatchLinkBox";
import { OverlayTokenBox, OverlayTokenError, OverlayTokenStart, useMyOverlayToken } from "../components/OverlayToken";
import { MIN_OPACITY, MIN_ALERT_SECS, MAX_ALERT_SECS, DEFAULT_ALERT_SECS } from "../lib/overlayCast";
import { MIN_TEXT_SIZE, MAX_TEXT_SIZE } from "../lib/overlayText";
import { sourcesFor, streamSourceUrl, type SceneKind, type SceneSettings } from "../lib/streamOverlay";
import { playerSceneParts } from "../lib/obsScene";
import { CasterSceneSetup } from "../components/CasterSceneSetup";
import { PlayerFramePieces, PlayerSceneSetup } from "../components/PlayerSceneSetup";
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
 * The token names the player rather than the room, so a downloaded scene or a pasted URL follows
 * them from match to match and never goes stale. See lib/streamOverlay. A player gets the frame as
 * one file (PlayerSceneSetup) or "Just the pieces": every element's URL and the frame taken apart,
 * with no file to import.
 */

const DEFAULTS: SceneSettings = {
  opacity: 1,
  textSize: 1,
  emptyFade: 1,
  alertSecs: DEFAULT_ALERT_SECS,
};

export function Streaming() {
  const t = useT();
  /** A Twitch account and its token, or nothing - see components/OverlayToken. */
  const mine = useMyOverlayToken();
  const { token } = mine;

  const [kind, setKind] = useState<SceneKind>("player");
  /** A player's two ways in: the finished frame scene as one file, or every piece's URL on its own. */
  const [playerWay, setPlayerWay] = useState<"frame" | "loose">("frame");

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

  const scene: SceneSettings = { opacity, textSize, emptyFade, alertSecs };
  const isCaster = kind === "caster";

  // Built from window.location so the URLs stay right on localhost, on GitHub Pages under its
  // /Elden-Battleship/ base, and anywhere else this is hosted. Hardcoding the deployed origin would
  // hand every local tester a scene pointing at production - same reasoning as OverlayLinkBox.
  const base = `${window.location.origin}${window.location.pathname}`;

  // Every player element, nothing to tick: each is copied on its own, so offering one costs nothing.
  const entries = useMemo(
    () =>
      token
        ? sourcesFor("player").map((source) => ({ source, url: streamSourceUrl(base, source, token, scene, DEFAULTS) }))
        : [],
    // The scene settings are spread rather than passed as an object so a slider actually invalidates
    // this - a fresh `scene` object every render would make the memo pointless in the other direction.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [token, base, opacity, textSize, emptyFade, alertSecs]
  );

  // The whole frame, every optional part included - the player leaves out whatever they don't paste.
  const frameParts = useMemo(
    () => (token ? playerSceneParts({ base, token, textSize, alertSecs, fleet: true, finds: true, sound: true }) : []),
    [token, base, textSize, alertSecs]
  );

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
        in "paste your token into Dionysus Arcade", so somebody who has not got Dionysus installed
        needs to find that out at the top of the page rather than after they have built a scene.
        The overlay below needs nothing but OBS, so it can wait its turn.
      */}
      <AutoFireSetup />

      {/* -- the overlay ------------------------------------------------------------------------ */}
      <div className="panel stack" style={{ gap: "0.6rem", padding: "0.7rem" }}>
        <strong style={{ fontSize: "0.86rem" }}>{t("Stream overlay", "Overlay de stream")}</strong>

        <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
          {t(
            "Set it up once. The URLs never change - join your next match and the overlay is already on it.",
            "Configurez-le une fois. Les URL ne changent jamais - rejoignez votre prochaine partie et l'overlay y est déjà."
          )}
        </span>

        {!mine.signedIn || !token ? (
          <OverlayTokenStart mine={mine} />
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
              {!isCaster && (
                <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
                  {t(
                    "Your own scene - the board you're playing off, and the clock. Your fleet is filled in when the match starts, so you can change crews without touching anything.",
                    "Votre propre scène - le plateau sur lequel vous jouez, et l'horloge. Votre flotte se remplit au début de la partie, vous pouvez donc changer d'équipe sans rien toucher."
                  )}
                </span>
              )}
            </div>

            {/* A caster gets the whole broadcast layout - see components/CasterSceneSetup. */}
            {!isCaster && (
              <div className="stack" style={{ gap: "0.25rem" }}>
                <span style={{ fontSize: "0.78rem" }}>{t("Which scene?", "Quelle scène ?")}</span>
                <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
                  <button
                    onClick={() => setPlayerWay("frame")}
                    style={{ fontSize: "0.74rem", borderColor: playerWay === "frame" ? "var(--accent)" : undefined }}
                  >
                    {t("The full frame", "Le cadre complet")}
                  </button>
                  <button
                    onClick={() => setPlayerWay("loose")}
                    style={{ fontSize: "0.74rem", borderColor: playerWay === "loose" ? "var(--accent)" : undefined }}
                  >
                    {t("Just the pieces", "Juste les éléments")}
                  </button>
                </div>
                <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
                  {playerWay === "frame"
                    ? t(
                        "A finished layout: your game, webcam, fire board and fleet inside the Elden Battleship frame.",
                        "Une mise en page finie : votre jeu, votre webcam, votre plateau de tir et votre flotte dans le cadre Elden Battleship."
                      )
                    : t(
                        "Every element as its own URL, to arrange over your own layout - or build the frame yourself from its sources and PNGs at the bottom.",
                        "Chaque élément comme sa propre URL, à disposer sur votre propre mise en page - ou montez le cadre vous-même à partir de ses sources et PNG en bas."
                      )}
                </span>
              </div>
            )}

            {isCaster ? (
              <CasterSceneSetup base={base} token={token} />
            ) : playerWay === "frame" ? (
              <PlayerSceneSetup base={base} token={token} />
            ) : (
            <>
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

            {/* -- every piece --------------------------------------------------------------- */}
            <div className="stack" style={{ gap: "0.4rem" }}>
              <span style={{ fontSize: "0.78rem" }}>{t("Browser Sources", "Sources navigateur")}</span>
              <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
                {t(
                  "In OBS, add a Browser Source, paste the URL and give it the size shown. Take only the ones you want. Paste one in and it never needs changing.",
                  "Dans OBS, ajoutez une Browser Source, collez l'URL et donnez-lui la taille indiquée. Prenez seulement celles que vous voulez. Collez-en une et elle n'a plus jamais besoin de changer."
                )}
              </span>
              {[...entries, ...frameParts.flatMap((p) => (p.entry?.source.element === "frame" ? [p.entry] : []))].map(({ source, url }) => (
                <div key={source.id} className="stack" style={{ gap: "0.15rem" }}>
                  <SourceRow label={source.label} url={url} size={`${source.width} x ${source.height}`} note={source.note} />
                  {source.spoiler && (
                    <span style={{ fontSize: "0.68rem", lineHeight: 1.35, color: "var(--hit)" }}>
                      <strong>
                        {t(
                          "This one draws your ships. Put it on stream only if you want viewers to see where your hulls are.",
                          "Celle-ci dessine vos navires. Ne la mettez en stream que si vous voulez que les spectateurs voient où sont vos coques."
                        )}
                      </strong>
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* The player frame taken apart - its URL is the last row of the list above. */}
            <details className="stack" style={{ gap: "0.4rem" }}>
              <summary style={{ fontSize: "0.78rem", cursor: "pointer" }}>
                {t("Build the frame yourself", "Monter le cadre vous-même")}
              </summary>
              <PlayerFramePieces parts={frameParts} />
            </details>
            </>
            )}

            {/* -- the token ------------------------------------------------------------------ */}
            <OverlayTokenBox mine={mine} token={token} />
          </>
        )}

        <OverlayTokenError mine={mine} />

        <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.4 }}>
          {t("Want a scene for one particular room? The", "Vous voulez une scène pour une seule partie ? La boîte")}{" "}
          <strong>{t("Stream overlay", "Overlay de stream")}</strong>{" "}
          {t("box inside a room hands out URLs for that room alone.", "à l'intérieur d'une partie distribue des URL pour cette partie uniquement.")}
        </span>
      </div>

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
