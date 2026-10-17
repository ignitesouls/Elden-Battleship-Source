import { useEffect, useMemo, useState } from "react";
import { PlayerScenePreview } from "./PlayerScenePreview";
import { OverlaySetting as Setting, textReadout } from "./OverlaySetting";
import { SourceRow } from "./SourceRow";
import { PLAYER_ART } from "../lib/castSceneLayout";
import { buildPlayerCollection, playerSceneFilename, playerSceneParts, PLAYER_SCENE, type PlayerPart } from "../lib/obsScene";
import { DEFAULT_ALERT_SECS, MAX_ALERT_SECS, MIN_ALERT_SECS } from "../lib/overlayCast";
import { MAX_TEXT_SIZE, MIN_TEXT_SIZE } from "../lib/overlayText";
import { sourcesFor, streamSourceUrl, type SceneSettings } from "../lib/streamOverlay";
import { useT } from "../lib/language";
import type { DeepMark } from "../lib/deepWater";
import "./CasterSceneSetup.css";

const DEFAULTS: SceneSettings = { opacity: 1, textSize: 1, emptyFade: 1, alertSecs: DEFAULT_ALERT_SECS };

/** The player sources that have no hole in the frame, offered as extras. */
const EXTRA_IDS = ["timer", "key", "fire-mini"];

/**
 * "...place at 600, 0, bounding box 1319 x 742" - what to type into OBS for one part. Browser
 * sources are already their box's size (see playerSceneParts), so they only need the position.
 */
function whereItGoes(part: PlayerPart, t: ReturnType<typeof useT>): string {
  const { x, y } = part.at;
  const shown = part.fit
    ? t(`, bounding box ${part.fit.w} x ${part.fit.h} (Ctrl+E)`, `, boîte englobante ${part.fit.w} x ${part.fit.h} (Ctrl+E)`)
    : "";
  return `${part.what} - ${t("place at", "placez à")} ${x}, ${y}${shown}`;
}

/**
 * The player's finished scene: their gameplay, webcam, fire board and fleet inside the Elden
 * Battleship player frame. The other way in - every element as its own source, arranged by hand - is
 * still the page's other option; see pages/Streaming.
 *
 * Laid out like CasterSceneSetup and wearing its classes: see it, tune it, get it into OBS, then the
 * two things a file can't do for you.
 */
export function PlayerSceneSetup({ base, token }: { base: string; token: string }) {
  const t = useT();
  const [textSize, setTextSize] = useState(1);
  const [fleet, setFleet] = useState(true);
  // Off by default - see `finds` in lib/obsScene PlayerSceneOptions.
  const [finds, setFinds] = useState(false);
  const [alertSecs, setAlertSecs] = useState(DEFAULT_ALERT_SECS);
  const [sound, setSound] = useState(true);

  const [playing, setPlaying] = useState<DeepMark | null>(null);
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => setPlaying(null), alertSecs * 1000);
    return () => clearTimeout(timer);
  }, [playing, alertSecs]);

  const options = { base, token, textSize, fleet, finds, alertSecs, sound };
  const parts = useMemo(
    () => playerSceneParts(options),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [base, token, textSize, fleet, finds, alertSecs, sound]
  );

  const extras = useMemo(() => {
    const scene: SceneSettings = { ...DEFAULTS, textSize, alertSecs };
    return sourcesFor("player")
      .filter((s) => EXTRA_IDS.includes(s.id))
      .map((source) => ({ source, url: streamSourceUrl(base, source, token, scene, DEFAULTS) }));
  }, [base, token, textSize, alertSecs]);

  function download() {
    const collection = buildPlayerCollection(options);
    const blob = new Blob([JSON.stringify(collection, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = playerSceneFilename();
    a.click();
    URL.revokeObjectURL(url);
  }

  const art = (file: string) => `${import.meta.env.BASE_URL}${file}`;

  return (
    <div className="stack cst" style={{ gap: "1rem" }}>
      <div className="stack" style={{ gap: "0.4rem" }}>
        <PlayerScenePreview textSize={textSize} fleet={fleet} alertMark={finds ? playing : null} />
        <span className="muted cst-small">
          {t(
            "Sample footage and sample boards. On stream it's your game, your camera, and your real shots and fleet.",
            "Images et plateaux d'exemple. En direct, c'est votre jeu, votre caméra, et vos vrais tirs et votre vraie flotte."
          )}
        </span>
      </div>

      {/* -- 1. customise ------------------------------------------------------------------------- */}
      <section className="stack cst-step">
        <h3>
          <span className="cst-num">1</span>
          {t("Make it yours", "Personnalisez")}
        </h3>

        <Setting
          label={t("Text size", "Taille du texte")}
          hint={t(
            "How much of each square its name fills on your fire board. Text never overflows: a size that doesn't fit draws as large as it can.",
            "Quelle part de chaque case son nom remplit sur votre plateau de tir. Le texte ne dépasse jamais : une taille qui ne rentre pas se dessine aussi grande que possible."
          )}
          min={MIN_TEXT_SIZE}
          max={MAX_TEXT_SIZE}
          step={0.05}
          value={textSize}
          onChange={setTextSize}
          readout={textReadout(textSize)}
        />

        <label className="obs-pick">
          <input type="checkbox" checked={fleet} onChange={() => setFleet((v) => !v)} />
          <span className="stack" style={{ gap: "0.1rem" }}>
            <span style={{ fontSize: "0.78rem" }}>{t("Your fleet", "Votre flotte")}</span>
            <span className="muted cst-small">
              {t(
                "Your ships and the damage they've taken, in the bottom-left box. Untick it and that box stays empty.",
                "Vos navires et les dégâts subis, dans le cadre en bas à gauche. Décochez-la et ce cadre reste vide."
              )}
            </span>
            {fleet && (
              <span className="cst-small" style={{ color: "var(--hit)" }}>
                <strong>
                  {t(
                    "This shows viewers where your ships are. Leave it on only if you're fine with that.",
                    "Ceci montre aux spectateurs où sont vos navires. Laissez-la seulement si cela vous convient."
                  )}
                </strong>
              </span>
            )}
          </span>
        </label>

        <label className="obs-pick">
          <input type="checkbox" checked={finds} onChange={() => setFinds((v) => !v)} />
          <span className="stack" style={{ gap: "0.1rem" }}>
            <span style={{ fontSize: "0.78rem" }}>{t("Find alerts", "Alertes de découverte")}</span>
            <span className="muted cst-small">
              {t(
                "Off unless you want them. When your crew finds something in the water, a card pops up over your gameplay for a few seconds.",
                "Désactivées sauf si vous les voulez. Quand votre équipe trouve quelque chose dans l'eau, une carte apparaît sur votre gameplay quelques secondes."
              )}
            </span>
          </span>
        </label>
        {finds && (
          <div className="stack cst-indent" style={{ gap: "0.4rem" }}>
            <Setting
              label={t("Alert time", "Durée de l'alerte")}
              hint={t("How long the card stays up.", "Combien de temps la carte reste affichée.")}
              min={MIN_ALERT_SECS}
              max={MAX_ALERT_SECS}
              step={1}
              value={alertSecs}
              onChange={setAlertSecs}
              readout={`${alertSecs}s`}
            />
            <button onClick={() => setPlaying(playing ? null : "whale")} style={{ fontSize: "0.74rem", alignSelf: "flex-start" }}>
              {playing ? t("Stop", "Arrêter") : t("Show a sample alert", "Montrer une alerte d'exemple")}
            </button>
          </div>
        )}

        <label className="obs-pick">
          <input type="checkbox" checked={sound} onChange={() => setSound((v) => !v)} />
          <span className="stack" style={{ gap: "0.1rem" }}>
            <span style={{ fontSize: "0.78rem" }}>{t("Board sound", "Son du plateau")}</span>
            <span className="muted cst-small">
              {t(
                "Hit, sink and win sounds, on their own fader in the OBS mixer.",
                "Les sons de touche, de coulé et de victoire, sur leur propre curseur dans le mixeur OBS."
              )}
            </span>
          </span>
        </label>
      </section>

      {/* -- 2. into OBS -------------------------------------------------------------------------- */}
      <section className="stack cst-step">
        <h3>
          <span className="cst-num">2</span>
          {t("Get it into OBS", "Importez dans OBS")}
        </h3>

        <div className="cst-ways">
          <div className="stack cst-way cst-way-main">
            <strong>
              {t("The whole scene", "La scène complète")} <span className="cst-badge">{t("Recommended", "Recommandé")}</span>
            </strong>
            <span className="muted cst-small">
              {t("Everything already in its box, in one file.", "Tout est déjà dans son cadre, dans un seul fichier.")}
            </span>
            <button className="primary" onClick={download}>
              {t("Download scene", "Télécharger la scène")}
            </button>
            <ol className="cst-list">
              <li>
                {t("In OBS, open", "Dans OBS, ouvrez")} <strong>{t("Scene Collection → Import", "Collection de scènes → Importer")}</strong>
                {t(" and pick the file.", " et choisissez le fichier.")}
              </li>
              <li>
                {t("Open", "Ouvrez")} <strong>{t("Scene Collection", "Collection de scènes")}</strong> {t("again and switch to", "à nouveau et basculez sur")}{" "}
                <strong>{PLAYER_SCENE}</strong>.
              </li>
            </ol>
          </div>

          <div className="stack cst-way">
            <strong>{t("Piece by piece", "Pièce par pièce")}</strong>
            <span className="muted cst-small">
              {t(
                "For adding to a scene you already have, on a 1920x1080 canvas. Stack them in this order, first in the list at the bottom. Browser Sources take the size shown; for the game and camera, set the bounding box in Edit Transform (Ctrl+E).",
                "Pour compléter une scène existante, sur un canevas 1920x1080. Empilez-les dans cet ordre, la première de la liste en bas. Les Browser Sources prennent la taille indiquée ; pour le jeu et la caméra, réglez la boîte englobante dans Modifier la transformation (Ctrl+E)."
              )}
            </span>
            <details className="cst-details">
              <summary>{t("Scene sources", "Sources de la scène")}</summary>
              <div className="stack" style={{ gap: "0.5rem" }}>
                {parts.map((p) =>
                  p.entry ? (
                    <SourceRow
                      key={p.name}
                      label={p.name}
                      url={p.entry.url}
                      size={`${p.entry.source.width} x ${p.entry.source.height}`}
                      note={whereItGoes(p, t)}
                    />
                  ) : (
                    <div key={p.name} className="stack" style={{ gap: "0.1rem" }}>
                      <span style={{ fontSize: "0.76rem" }}>{p.name}</span>
                      <span className="muted cst-small">{whereItGoes(p, t)}</span>
                    </div>
                  )
                )}
              </div>
            </details>
            <details className="cst-details">
              <summary>{t("Frame images (PNG)", "Images du cadre (PNG)")}</summary>
              <span className="muted cst-small">
                {t(
                  "The frame on its own, 1920 x 1080 with see-through boxes, and a map of which source goes in which box.",
                  "Le cadre seul, 1920 x 1080 avec des cadres transparents, et un plan indiquant quelle source va dans quel cadre."
                )}
              </span>
              <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                <a className="cst-file" href={art(PLAYER_ART.frame)} download="B_Ship_Player_Overlay.png">
                  <img src={art(PLAYER_ART.frame)} alt="" />
                  {t("Frame", "Cadre")}
                </a>
                <a className="cst-file" href={art(PLAYER_ART.guide)} download="B_Ship_Player_Overlay_Map.png">
                  <img src={art(PLAYER_ART.guide)} alt="" />
                  {t("What goes where", "Quoi va où")}
                </a>
              </div>
            </details>
          </div>
        </div>

        <span className="cst-small" style={{ color: "var(--hit)" }}>
          <strong>{t("Change settings before you import, not after.", "Changez les réglages avant l'import, pas après.")}</strong>{" "}
          {t(
            "Downloading again makes a brand-new scene: anything you moved or added in OBS isn't carried over.",
            "Télécharger à nouveau crée une toute nouvelle scène : ce que vous avez déplacé ou ajouté dans OBS n'est pas repris."
          )}
        </span>
      </section>

      {/* -- 3. the one thing a file can't do ------------------------------------------------------- */}
      <section className="stack cst-step">
        <h3>
          <span className="cst-num">3</span>
          {t("Pick your camera", "Choisissez votre caméra")}
        </h3>
        <ol className="cst-list">
          <li>
            {t(
              "Double-click Your Webcam in the Sources list and pick your camera from Device. It's already sized to its box.",
              "Double-cliquez sur Your Webcam dans la liste des Sources et choisissez votre caméra dans Device. Elle est déjà ajustée à son cadre."
            )}
          </li>
          <li>
            {t(
              "That's it. ER Gameplay is already aimed at Elden Ring and appears once the game is running. Your fire board and fleet stay empty until you're in a match, then fill in on their own - every match, with nothing to paste.",
              "C'est tout. ER Gameplay vise déjà Elden Ring et apparaît dès que le jeu tourne. Votre plateau de tir et votre flotte restent vides tant que vous n'êtes pas en partie, puis se remplissent tout seuls - à chaque partie, sans rien coller."
            )}
          </li>
        </ol>

        <details className="cst-details">
          <summary>{t("If something's not right", "Si quelque chose cloche")}</summary>
          <ul className="cst-list">
            <li>
              <strong>{t("Game stays black with Elden Ring running:", "Le jeu reste noir alors qu'Elden Ring tourne :")}</strong>{" "}
              {t(
                "double-click ER Gameplay and pick ELDEN RING™ from the Window list.",
                "double-cliquez sur ER Gameplay et choisissez ELDEN RING™ dans la liste Window."
              )}
            </li>
            <li>
              <strong>{t("Boxes don't line up with the frame:", "Les cadres ne s'alignent pas sur le cadre :")}</strong>{" "}
              {t(
                "the scene is built for a 16:9 canvas. OBS 31 or newer fits it to any 16:9 size on its own; on an older OBS, set Settings → Video → Base (Canvas) Resolution to 1920x1080 and import again.",
                "la scène est faite pour un canevas 16:9. OBS 31 ou plus récent l'ajuste tout seul à toute taille 16:9 ; sur un OBS plus ancien, réglez Paramètres → Vidéo → Résolution de base (canevas) sur 1920x1080 et réimportez."
              )}
            </li>
            <li>
              <strong>{t("You'd rather keep your own game capture and camera", "Vous préférez garder votre capture de jeu et votre caméra")}</strong>{" "}
              {t(
                "(with their filters): scene collections don't share sources, so don't import. Use Piece by piece inside the collection you already stream from.",
                "(avec leurs filtres) : les collections de scènes ne partagent pas leurs sources, donc n'importez pas. Utilisez Pièce par pièce dans la collection depuis laquelle vous diffusez déjà."
              )}
            </li>
            <li>
              <strong>{t("On a Mac or Linux:", "Sur Mac ou Linux :")}</strong>{" "}
              {t(
                "ER Gameplay and Your Webcam are Windows sources and won't open. Delete them, add your own capture and camera, and drag both below EB Player Frame in the Sources list.",
                "ER Gameplay et Your Webcam sont des sources Windows et ne s'ouvriront pas. Supprimez-les, ajoutez votre propre capture et caméra, et glissez-les sous EB Player Frame dans la liste des Sources."
              )}
            </li>
          </ul>
        </details>
      </section>

      {/* -- extras ------------------------------------------------------------------------------- */}
      <details className="cst-details">
        <summary>{t("More sources (optional)", "Plus de sources (optionnel)")}</summary>
        <span className="muted cst-small">
          {t(
            "Not in the frame - it has no box for them. Add them yourself if you want them on top.",
            "Absentes du cadre - il n'a pas de place pour elles. Ajoutez-les vous-même si vous les voulez par-dessus."
          )}
        </span>
        <div className="stack" style={{ gap: "0.5rem" }}>
          {extras.map(({ source, url }) => (
            <SourceRow key={source.id} label={source.obsName} url={url} size={`${source.width} x ${source.height}`} note={source.note} />
          ))}
        </div>
      </details>
    </div>
  );
}
