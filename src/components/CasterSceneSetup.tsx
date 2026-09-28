import { useEffect, useMemo, useState } from "react";
import { CastScenePreview } from "./CastScenePreview";
import { OverlaySetting as Setting, textReadout } from "./OverlaySetting";
import { SourceRow } from "./SourceRow";
import { CAST_ART } from "../lib/castSceneLayout";
import { buildCastCollection, castSceneFilename, castSceneParts, CAST_SCENE_MAIN, CAST_SCENE_BREAK, type CastPart } from "../lib/obsScene";
import { DEFAULT_ALERT_SECS, MAX_ALERT_SECS, MAX_DELAY_MS, MIN_ALERT_SECS, MIN_OPACITY } from "../lib/overlayCast";
import { MAX_TEXT_SIZE, MIN_TEXT_SIZE } from "../lib/overlayText";
import { sourcesFor, streamCastUrl, streamSourceUrl, type SceneSettings } from "../lib/streamOverlay";
import { useT } from "../lib/language";
import type { DeepMark } from "../lib/deepWater";
import "./CasterSceneSetup.css";

const DEFAULTS: SceneSettings = { opacity: 1, textSize: 1, emptyFade: 1, alertSecs: DEFAULT_ALERT_SECS };

/** The caster sources that are not part of the ready-made scene, offered as extras. */
const EXTRA_IDS = ["odds", "key", "all-fleets"];

/** "Browser Source 1000 x 1000, at 644, 114, resized to 632 x 632" - what to type into OBS for one part. */
function whereItGoes(part: CastPart, t: ReturnType<typeof useT>): string {
  const { source } = part.entry;
  const { x, y, scale } = part.at;
  const shown =
    scale === 1
      ? ""
      : t(
          `, resized to ${Math.round(source.width * scale)} x ${Math.round(source.height * scale)}`,
          `, redimensionnée à ${Math.round(source.width * scale)} x ${Math.round(source.height * scale)}`
        );
  return `${part.what} - ${t("place at", "placez à")} ${x}, ${y}${shown}`;
}

/**
 * Everything a caster needs, in the order they need it: see the scene, tune it, get it into OBS,
 * then run it on the day.
 *
 * -- One scene, two ways in ----------------------------------------------------------------------
 *
 * The ready-made scene is the frame art with every source already sitting in its hole, so the
 * download is the recommended path and gets the big button. Building it by hand is offered beside it
 * for a caster with an existing scene to add to: the same sources, URLs, sizes and positions the file
 * carries - both are read off castSceneParts, so the two can't disagree - plus the two PNGs.
 */
export function CasterSceneSetup({ base, token }: { base: string; token: string }) {
  const t = useT();
  const [view, setView] = useState<"match" | "break">("match");
  const [delayMs, setDelayMs] = useState(0);
  const [clockOpacity, setClockOpacity] = useState(1);
  const [clockText, setClockText] = useState(1);
  const [finds, setFinds] = useState(true);
  const [alertSecs, setAlertSecs] = useState(DEFAULT_ALERT_SECS);
  const [sound, setSound] = useState(true);

  /** A find held over the preview, so the alert setting has something to show. */
  const [playing, setPlaying] = useState<DeepMark | null>(null);
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => setPlaying(null), alertSecs * 1000);
    return () => clearTimeout(timer);
  }, [playing, alertSecs]);

  const options = { base, token, delayMs, clockOpacity, clockText, finds, alertSecs, sound };
  const parts = useMemo(
    () => castSceneParts(options),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [base, token, delayMs, clockOpacity, clockText, finds, alertSecs, sound]
  );

  const extras = useMemo(() => {
    const scene: SceneSettings = { opacity: clockOpacity, textSize: clockText, emptyFade: 1, alertSecs };
    return sourcesFor("caster")
      .filter((s) => EXTRA_IDS.includes(s.id))
      .map((source) => ({ source, url: streamSourceUrl(base, source, token, scene, DEFAULTS) }));
  }, [base, token, clockOpacity, clockText, alertSecs]);

  function download() {
    const collection = buildCastCollection(options);
    const blob = new Blob([JSON.stringify(collection, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = castSceneFilename();
    a.click();
    URL.revokeObjectURL(url);
  }

  const partRows = (scene: CastPart["scene"]) =>
    parts
      .filter((p) => p.scene === scene)
      .map((p) => (
        <SourceRow
          key={p.entry.source.obsName}
          label={p.entry.source.obsName}
          url={p.entry.url}
          size={`${p.entry.source.width} x ${p.entry.source.height}`}
          note={whereItGoes(p, t)}
        />
      ));

  return (
    <div className="stack cst" style={{ gap: "1rem" }}>
      <span className="muted cst-lede">
        {t(
          "A finished broadcast layout for a 3v3 match: all six players' streams, the board, the clock and odds, and boxes for you and your co-caster, inside the Elden Battleship frame. There's a second scene for breaks. Player streams fill themselves in from whichever match you join.",
          "Une mise en page de diffusion complète pour un match 3c3 : les flux des six joueurs, le plateau, l'horloge et les cotes, et des cadres pour vous et votre co-commentateur, dans le cadre Elden Battleship. Une seconde scène sert aux pauses. Les flux des joueurs se remplissent tout seuls selon la partie que vous rejoignez."
        )}
      </span>

      {/* -- the preview -------------------------------------------------------------------------- */}
      <div className="stack" style={{ gap: "0.4rem" }}>
        <div className="cst-tabs" role="tablist">
          <button role="tab" aria-selected={view === "match"} className={view === "match" ? "on" : ""} onClick={() => setView("match")}>
            {t("Match scene", "Scène de match")}
          </button>
          <button role="tab" aria-selected={view === "break"} className={view === "break" ? "on" : ""} onClick={() => setView("break")}>
            {t("Break scene", "Scène de pause")}
          </button>
        </div>
        <CastScenePreview
          scene={view}
          clockOpacity={clockOpacity}
          clockText={clockText}
          alertMark={finds && view === "match" ? playing : null}
        />
        <span className="muted cst-small">
          {view === "match"
            ? t(
                "Sample footage and a sample board. On stream, each box shows that player's live Twitch and their real hits, misses and accuracy.",
                "Images et plateau d'exemple. En direct, chaque cadre montre le Twitch du joueur et ses vrais touchés, manqués et précision."
              )
            : t(
                "For the parts of the show that aren't a match. It's just the frame: your webcams go in the two boxes.",
                "Pour les moments de l'émission hors match. Ce n'est que le cadre : vos webcams vont dans les deux cadres."
              )}
        </span>
      </div>

      {/* -- 1. customise ------------------------------------------------------------------------- */}
      <section className="stack cst-step">
        <h3>
          <span className="cst-num">1</span>
          {t("Make it yours", "Personnalisez")}
        </h3>
        <span className="muted cst-small">
          {t(
            "These are saved into the scene when you download it. The board's zoom, spotlight and look are set live from your caster desk instead (step 3).",
            "Ces réglages sont enregistrés dans la scène au téléchargement. Le zoom, le projecteur et l'apparence du plateau se règlent en direct depuis votre poste de commentaire (étape 3)."
          )}
        </span>

        <Setting
          label={t("Stream delay", "Décalage du flux")}
          hint={t(
            "Twitch runs a few seconds behind. Hold the clock back by the same amount so it doesn't show a kill before viewers see it on the player's stream. You can fine-tune this from the caster desk during the match too.",
            "Twitch a quelques secondes de retard. Retenez l'horloge d'autant pour qu'elle n'annonce pas un kill avant que les spectateurs le voient sur le flux du joueur. Vous pouvez aussi l'ajuster depuis le poste de commentaire pendant le match."
          )}
          min={0}
          max={MAX_DELAY_MS}
          step={100}
          value={delayMs}
          onChange={setDelayMs}
          readout={delayMs === 0 ? t("none", "aucun") : `${(delayMs / 1000).toFixed(1)}s`}
        />
        <Setting
          label={t("Clock transparency", "Transparence de l'horloge")}
          hint={t("How much of the banner shows through the clock.", "Combien du bandeau transparaît à travers l'horloge.")}
          min={MIN_OPACITY}
          max={1}
          step={0.05}
          value={clockOpacity}
          onChange={setClockOpacity}
          readout={clockOpacity >= 1 ? t("solid", "plein") : `${Math.round(clockOpacity * 100)}%`}
        />
        <Setting
          label={t("Clock text size", "Taille du texte de l'horloge")}
          hint={t("Text never overflows: a size that doesn't fit draws as large as it can.", "Le texte ne dépasse jamais : une taille qui ne rentre pas se dessine aussi grande que possible.")}
          min={MIN_TEXT_SIZE}
          max={MAX_TEXT_SIZE}
          step={0.05}
          value={clockText}
          onChange={setClockText}
          readout={textReadout(clockText)}
        />

        <label className="obs-pick">
          <input type="checkbox" checked={finds} onChange={() => setFinds((v) => !v)} />
          <span className="stack" style={{ gap: "0.1rem" }}>
            <span style={{ fontSize: "0.78rem" }}>{t("Find alerts", "Alertes de découverte")}</span>
            <span className="muted cst-small">
              {t(
                "When a player finds something in the water, a card pops up over the board, then goes away.",
                "Quand un joueur trouve quelque chose dans l'eau, une carte apparaît sur le plateau, puis disparaît."
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
            <button
              onClick={() => {
                setView("match");
                setPlaying(playing ? null : "whale");
              }}
              style={{ fontSize: "0.74rem", alignSelf: "flex-start" }}
            >
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
                "Hit, sink and win sounds, on their own fader in the OBS mixer so you can turn them down under your voice.",
                "Les sons de touche, de coulé et de victoire, sur leur propre curseur dans le mixeur OBS pour les baisser sous votre voix."
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
              {t("Everything already in place, in one file.", "Tout est déjà en place, dans un seul fichier.")}
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
                <strong>{CAST_SCENE_MAIN}</strong>.
              </li>
              <li>
                {t("You now have two scenes:", "Vous avez maintenant deux scènes :")} <strong>{CAST_SCENE_MAIN}</strong>{" "}
                {t("for the match and", "pour le match et")} <strong>{CAST_SCENE_BREAK}</strong> {t("for breaks.", "pour les pauses.")}
              </li>
            </ol>
          </div>

          <div className="stack cst-way">
            <strong>{t("Piece by piece", "Pièce par pièce")}</strong>
            <span className="muted cst-small">
              {t(
                "For adding to a scene you already have. Add each one as a Browser Source at the size shown, and stack them in this order: first in the list at the bottom.",
                "Pour compléter une scène existante. Ajoutez chacune comme Browser Source à la taille indiquée, et empilez-les dans cet ordre : la première de la liste en bas."
              )}
            </span>
            <details className="cst-details">
              <summary>{t("Match scene sources", "Sources de la scène de match")}</summary>
              <div className="stack" style={{ gap: "0.5rem" }}>{partRows("main")}</div>
            </details>
            <details className="cst-details">
              <summary>{t("Break scene sources", "Sources de la scène de pause")}</summary>
              <div className="stack" style={{ gap: "0.5rem" }}>{partRows("break")}</div>
            </details>
            <details className="cst-details">
              <summary>{t("Frame images (PNG)", "Images des cadres (PNG)")}</summary>
              <span className="muted cst-small">
                {t(
                  "The frame art on its own, 1920 x 1080 with see-through boxes. Use it as an Image Source instead of the frame Browser Source, or in your own layout.",
                  "Le cadre seul, 1920 x 1080 avec des cadres transparents. Utilisez-le comme Image Source à la place de la Browser Source du cadre, ou dans votre propre mise en page."
                )}
              </span>
              <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                <a className="cst-file" href={`${import.meta.env.BASE_URL}${CAST_ART.match}`} download="Battleship_Overlays.png">
                  <img src={`${import.meta.env.BASE_URL}${CAST_ART.match}`} alt="" />
                  {t("Match frame", "Cadre de match")}
                </a>
                <a className="cst-file" href={`${import.meta.env.BASE_URL}${CAST_ART.break}`} download="Battleship_Casters.png">
                  <img src={`${import.meta.env.BASE_URL}${CAST_ART.break}`} alt="" />
                  {t("Break frame", "Cadre de pause")}
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

      {/* -- 3. on the day ------------------------------------------------------------------------ */}
      <section className="stack cst-step">
        <h3>
          <span className="cst-num">3</span>
          {t("On match day", "Le jour du match")}
        </h3>
        <ol className="cst-list">
          <li>
            <strong>{t("Add your webcams.", "Ajoutez vos webcams.")}</strong>{" "}
            {t(
              "Add a Video Capture Device, drag it below EB Frame in the Sources list so the frame sits on top, and size it to fill its box. Do the same in EB Casters.",
              "Ajoutez un Video Capture Device, faites-le glisser sous EB Frame dans la liste des Sources pour que le cadre passe au-dessus, et ajustez-le à son cadre. Faites de même dans EB Casters."
            )}
          </li>
          <li>
            <strong>{t("Join the match as a spectator.", "Rejoignez la partie en spectateur.")}</strong>{" "}
            {t(
              "The scene follows you in: player streams, names and stats fill themselves in. Nothing to paste per match.",
              "La scène vous suit : flux, noms et stats des joueurs se remplissent tout seuls. Rien à coller à chaque match."
            )}
          </li>
          <li>
            <strong>
              {t("Open", "Ouvrez")} <a href={streamCastUrl(base, token)}>{t("your caster desk", "votre poste de commentaire")}</a>
            </strong>{" "}
            {t(
              "in a normal browser window (not in OBS). It drives the board: zoom, pan, spotlight, markers and stream delay.",
              "dans une fenêtre de navigateur normale (pas dans OBS). Il pilote le plateau : zoom, panoramique, projecteur, marqueurs et décalage du flux."
            )}
          </li>
          <li>
            {t(
              "If a player's stream stalls or falls behind, open that EB Screen source's properties and press Refresh cache of current page.",
              "Si le flux d'un joueur se fige ou prend du retard, ouvrez les propriétés de sa source EB Screen et cliquez sur Refresh cache of current page."
            )}
          </li>
        </ol>
      </section>

      {/* -- extras ------------------------------------------------------------------------------- */}
      <details className="cst-details">
        <summary>{t("More sources (optional)", "Plus de sources (optionnel)")}</summary>
        <span className="muted cst-small">
          {t(
            "Not in the ready-made scene. Add them yourself if you want them - for example the odds panel to bring up on a big swing.",
            "Absentes de la scène toute faite. Ajoutez-les vous-même si vous le souhaitez - par exemple le panneau des cotes lors d'un gros retournement."
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
