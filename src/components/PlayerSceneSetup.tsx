import { useEffect, useState } from "react";
import { PlayerScenePreview } from "./PlayerScenePreview";
import { OverlaySetting as Setting, textReadout } from "./OverlaySetting";
import { PLAYER_ART } from "../lib/castSceneLayout";
import { buildPlayerCollection, playerSceneFilename, PLAYER_SCENE, type PlayerPart } from "../lib/obsScene";
import { DEFAULT_ALERT_SECS, MAX_ALERT_SECS, MIN_ALERT_SECS } from "../lib/overlayCast";
import { MAX_TEXT_SIZE, MIN_TEXT_SIZE } from "../lib/overlayText";
import { useT } from "../lib/language";
import type { DeepMark } from "../lib/deepWater";
import "./CasterSceneSetup.css";

/**
 * The player's finished scene: their gameplay, webcam, fire board and fleet inside the Elden
 * Battleship player frame, as one file. Everything handed over one piece at a time - each element as
 * its own source, and this frame taken apart (PlayerFramePieces) - is the page's other option; see
 * pages/Streaming.
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
              "Your Mic and ER Game Audio arrive muted, so nobody gets their voice twice. If Mic/Aux and Desktop Audio aren't already on in Settings → Audio, unmute them in the Audio Mixer. If they are, delete these two.",
              "Your Mic et ER Game Audio arrivent en sourdine, pour que personne n'ait sa voix en double. Si Micro/Aux et Audio du bureau ne sont pas déjà activés dans Paramètres → Audio, réactivez-les dans le Mélangeur audio. S'ils le sont, supprimez ces deux sources."
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
                "(with their filters): scene collections don't share sources, so don't import. Switch to Just the pieces and build the frame inside the collection you already stream from.",
                "(avec leurs filtres) : les collections de scènes ne partagent pas leurs sources, donc n'importez pas. Passez à Juste les éléments et montez le cadre dans la collection depuis laquelle vous diffusez déjà."
              )}
            </li>
            <li>
              <strong>{t("On a Mac or Linux:", "Sur Mac ou Linux :")}</strong>{" "}
              {t(
                "ER Gameplay, Your Webcam, Your Mic and ER Game Audio are Windows sources and won't open. Delete them, add your own capture, camera and audio, and drag the capture and camera below EB Player Frame in the Sources list.",
                "ER Gameplay, Your Webcam, Your Mic et ER Game Audio sont des sources Windows et ne s'ouvriront pas. Supprimez-les, ajoutez votre propre capture, caméra et audio, et glissez la capture et la caméra sous EB Player Frame dans la liste des Sources."
              )}
            </li>
          </ul>
        </details>
      </section>

    </div>
  );
}

/**
 * The player frame taken apart: where each piece goes, and the frame art as PNGs. No URLs - those are
 * all in the Browser Sources list right above it on the "Just the pieces" side of pages/Streaming, and
 * printing them twice is what made this section a wall. Sound-only parts are left out: they have no
 * place on the canvas.
 */
export function PlayerFramePieces({ parts }: { parts: PlayerPart[] }) {
  const t = useT();
  const art = (file: string) => `${import.meta.env.BASE_URL}${file}`;
  // Captures are sized by a bounding box; browser sources by their own width and height.
  const placed = parts.flatMap((p) => {
    if (p.fit) return [{ name: p.name, w: p.fit.w, h: p.fit.h, at: p.at, box: true }];
    if (p.entry && p.entry.source.element !== "audio")
      return [{ name: p.entry.source.label, w: p.entry.source.width, h: p.entry.source.height, at: p.at, box: false }];
    return [];
  });

  return (
    <div className="stack cst" style={{ gap: "0.5rem" }}>
      <span className="muted cst-small">
        {t(
          "On a 1920x1080 canvas. Keep Player frame above everything except Finds. For the game and camera, set the size as the bounding box in Edit Transform (Ctrl+E).",
          "Sur un canevas 1920x1080. Gardez Player frame au-dessus de tout sauf Finds. Pour le jeu et la caméra, réglez la taille comme boîte englobante dans Modifier la transformation (Ctrl+E)."
        )}
      </span>
      <div
        className="cst-small"
        style={{ display: "grid", gridTemplateColumns: "auto auto auto", gap: "0.2rem 1rem", justifyContent: "start" }}
      >
        {placed.map((p) => (
          <div key={p.name} style={{ display: "contents" }}>
            <span>{p.name}</span>
            <span className="muted">
              {p.w} x {p.h}
              {p.box && " (Ctrl+E)"}
            </span>
            <span className="muted">
              {t("at", "à")} {p.at.x}, {p.at.y}
            </span>
          </div>
        ))}
      </div>
      <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
        <a className="cst-file" href={art(PLAYER_ART.frame)} download="B_Ship_Player_Overlay.png">
          <img src={art(PLAYER_ART.frame)} alt="" />
          {t("Frame (PNG)", "Cadre (PNG)")}
        </a>
        <a className="cst-file" href={art(PLAYER_ART.guide)} download="B_Ship_Player_Overlay_Map.png">
          <img src={art(PLAYER_ART.guide)} alt="" />
          {t("What goes where (PNG)", "Quoi va où (PNG)")}
        </a>
      </div>
    </div>
  );
}
