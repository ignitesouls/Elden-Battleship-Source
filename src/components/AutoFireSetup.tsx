import { useEffect, useState, type ReactNode } from "react";
import { fetchIngestToken, createIngestToken, regenerateIngestToken, maskToken } from "../lib/autoFire";
import { useT } from "../lib/language";
import { AutoFireTest } from "./AutoFireTest";

/**
 * Where a player sets up auto-marking: mint a token, copy it into Dionysus, replace it if it
 * leaks, and four steps for getting it running.
 *
 * -- Why this lives on the profile page --------------------------------------------------------
 *
 * The token is per-person and permanent: it encodes no room, no team and no match, because all
 * three are resolved server-side at the moment a kill lands. So it belongs with identity rather
 * than with any one game. Paste it into Dionysus once and it keeps working across every room,
 * fleet and match afterwards.
 *
 * -- Why it is shown masked ----------------------------------------------------------------------
 *
 * Not because it is dangerous. The worst a leaked token can do is fire shots on your behalf in
 * whatever room you happen to be in, and it grants no reads at all. It is masked because this page
 * is the one people screenshot to show off a career, and a secret that only appears when asked for
 * cannot end up in someone's highlight reel by accident.
 *
 * -- Why the player only gets a token ------------------------------------------------------------
 *
 * Until Dionysus Arcade 0.3 the overlay read its token out of a config file, so this panel handed
 * over that entire file and the guide was "open it, select all, paste, save". Dionysus now has a
 * Battleship token field in its own Settings window and writes the file itself, endpoint included.
 * The website's whole job shrank to one string, and the guide to four clicks with a picture of
 * each window, so nothing in it needs a folder path or a keyboard shortcut.
 */

export function AutoFireSetup() {
  const t = useT();
  /** `undefined` while loading, `null` when the player has never made one. */
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [revealed, setRevealed] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  /**
   * The four steps, open from the start.
   *
   * This panel's home is a page called "OBS & auto-marking" that people open for no other reason.
   * Handing somebody a token and hiding "where to put it" behind a toggle is the whole setup failing
   * quietly - they copy the token, look for somewhere to paste it, find nothing, and leave.
   */
  const [guideOpen, setGuideOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setToken(await fetchIngestToken());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setToken(null);
      }
    })();
  }, []);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      setToken(await action());
      // Revealed on creation: you just asked for it in order to paste it somewhere, so hiding it
      // behind a second click would be ceremony rather than caution.
      setRevealed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirmingReset(false);
    }
  }

  if (token === undefined) return null;

  return (
    <div className="panel stack" style={{ gap: "0.5rem", padding: "0.6rem" }}>
      <strong style={{ fontSize: "0.82rem" }}>{t("Auto-marking", "Marquage automatique")}</strong>

      <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.4 }}>
        {t(
          "Kill a boss in game and its square fires itself. The game supplies the kill time, so it doesn't matter how long you take to alt-tab. Boss boards only - Objectives can't be detected.",
          "Tuez un boss en jeu et sa case se marque toute seule. Le jeu fournit l'heure de la mort, donc le temps que vous mettez à revenir sur l'écran n'a pas d'importance. Plateaux de boss uniquement - les objectifs ne peuvent pas être détectés."
        )}
      </span>

      {token === null ? (
        <>
          <button onClick={() => void run(createIngestToken)} disabled={busy} style={{ fontSize: "0.78rem" }}>
            {busy ? t("Setting up...", "Configuration...") : t("Get my token", "Obtenir mon token")}
          </button>
          <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
            {t("You paste it into Dionysus Arcade, once.", "Vous le collez dans Dionysus Arcade, une seule fois.")}
          </span>
        </>
      ) : (
        <>
          <input
            readOnly
            value={revealed ? token : maskToken(token)}
            onFocus={(e) => revealed && e.currentTarget.select()}
            spellCheck={false}
            aria-label={t("Your Battleship token", "Votre token Battleship")}
            style={{ fontFamily: "monospace", fontSize: "0.72rem", width: "100%" }}
          />

          <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(token);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              style={{ fontSize: "0.74rem" }}
            >
              {copied ? t("Copied", "Copié") : t("Copy token", "Copier le token")}
            </button>
            <button onClick={() => setRevealed((r) => !r)} style={{ fontSize: "0.74rem" }}>
              {revealed ? t("Hide", "Masquer") : t("Reveal", "Révéler")}
            </button>

            {/* Two clicks, because the first one is irreversible and silent: the old token stops
                working immediately, and the only symptom is that somebody's overlay quietly stops
                marking squares mid-session. */}
            {confirmingReset ? (
              <>
                <button
                  onClick={() => void run(regenerateIngestToken)}
                  disabled={busy}
                  style={{ fontSize: "0.74rem", borderColor: "var(--hit)" }}
                >
                  {busy ? t("Replacing...", "Remplacement...") : t("Yes, replace it", "Oui, remplacer")}
                </button>
                <button onClick={() => setConfirmingReset(false)} style={{ fontSize: "0.74rem" }}>
                  {t("Cancel", "Annuler")}
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmingReset(true)}
                style={{ fontSize: "0.74rem" }}
                title={t("Replaces the token. The old one stops working straight away.", "Remplace le token. L'ancien arrête de fonctionner immédiatement.")}
              >
                {t("Replace", "Remplacer")}
              </button>
            )}
          </div>

          {confirmingReset && (
            <span style={{ fontSize: "0.68rem", lineHeight: 1.35, color: "var(--hit)" }}>
              {t(
                "The old token stops working immediately. Paste the new one into Dionysus Arcade before it can mark anything again.",
                "L'ancien token arrête de fonctionner immédiatement. Collez le nouveau dans Dionysus Arcade avant qu'il puisse à nouveau marquer quoi que ce soit."
              )}
            </span>
          )}

          <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
            {t(
              "Anyone who has your token can fire shots as you. It can't read or change anything else, but replace it if it gets out.",
              "Quiconque possède votre token peut tirer des coups à votre place. Il ne peut ni lire ni changer autre chose, mais remplacez-le s'il venait à fuiter."
            )}
          </span>
        </>
      )}

      {error && (
        <span className="error-text" style={{ fontSize: "0.7rem" }}>
          {error}
        </span>
      )}

      {/* Offered whether or not a token exists: someone who has never pressed the button deserves
          to see what they are signing up for before they mint a secret. */}
      <button
        onClick={() => setGuideOpen((o) => !o)}
        aria-expanded={guideOpen}
        style={{ fontSize: "0.74rem", alignSelf: "flex-start" }}
      >
        {guideOpen ? "▾" : "▸"} {t("How to set it up", "Comment le configurer")}
      </button>

      {guideOpen && <SetupGuide />}

      {/* After the guide: the test only means something once the token is in Dionysus. */}
      {token !== null && <AutoFireTest />}
    </div>
  );
}

/**
 * Four steps, in the order the player meets them, with a screenshot of each Dionysus window.
 *
 * Every step is an imperative naming one action, and the body says only what the title cannot.
 * The screenshots carry a ring around the one control the step is about, so nobody has to read the
 * picture to find it.
 */
function SetupGuide() {
  const t = useT();
  return (
    <div className="stack" style={{ gap: "0.7rem", paddingTop: "0.2rem" }}>
      <Step n={1} title={t("Open Dionysus Arcade", "Ouvrez Dionysus Arcade")}>
        <p style={body}>
          {t(
            "Version 0.3 or newer. Older versions have no token field.",
            "Version 0.3 ou plus récente. Les versions antérieures n'ont pas de champ pour le token."
          )}
        </p>
      </Step>

      <Step n={2} title={t("Click the settings gear", "Cliquez sur l'engrenage des paramètres")}>
        <p style={body}>{t("Top right of the window.", "En haut à droite de la fenêtre.")}</p>
        <Shot
          src="autofire/dionysus-main.png"
          alt={t(
            "The Dionysus Arcade main window, with the settings gear in the top right corner",
            "La fenêtre principale de Dionysus Arcade, avec l'engrenage des paramètres en haut à droite"
          )}
          width={960}
          height={720}
          ring={{ circle: [920.5, 69.5], r: 22 }}
          arrow={[[790, 200], [900.5, 89.5]]}
        />
      </Step>

      <Step n={3} title={t("Copy your token", "Copiez votre token")}>
        <p style={body}>
          {t("Press", "Appuyez sur")} <strong>{t("Copy token", "Copier le token")}</strong>{" "}
          {t("above.", "ci-dessus.")}
        </p>
      </Step>

      <Step n={4} title={t("Paste it and click Save", "Collez-le et cliquez sur Save")}>
        <p style={body}>
          {t(
            "Paste into the Battleship token field. It takes effect the next time you launch Elden Ring.",
            "Collez-le dans le champ Battleship token. Il prend effet au prochain lancement d'Elden Ring."
          )}
        </p>
        <Shot
          src="autofire/dionysus-settings.png"
          alt={t(
            "The Dionysus Arcade Settings window, with the Battleship token field and its Save button",
            "La fenêtre Settings de Dionysus Arcade, avec le champ Battleship token et son bouton Save"
          )}
          width={680}
          height={640}
          ring={{ rect: [22, 270, 453, 48] }}
          arrow={[[640, 210], [483, 287]]}
        />
      </Step>
    </div>
  );
}

const body = { fontSize: "0.7rem", lineHeight: 1.45, margin: 0 } as const;

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="stack" style={{ gap: "0.35rem" }}>
      <strong style={{ fontSize: "0.76rem", color: "var(--accent)" }}>
        {n}. {title}
      </strong>
      {children}
    </div>
  );
}

type Point = [number, number];
type Ring = { circle: Point; r: number } | { rect: [x: number, y: number, w: number, h: number] };

/**
 * A reference screenshot with a ring around the control the step names and an arrow pointing at it.
 *
 * Both are an SVG laid over the image with the image's own size as its viewBox, so every number at
 * the call sites is a pixel read straight off the PNG and the marks scale with it exactly. A fresh
 * screenshot after a Dionysus redesign is a file swap plus a few coordinates, not an image edit.
 * The border sits on the wrapper rather than the img so the two share one box to the pixel.
 */
function Shot({
  src,
  alt,
  width,
  height,
  ring,
  arrow,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  ring: Ring;
  /** Tail, then tip. The tip should stop just short of the ring. */
  arrow: [Point, Point];
}) {
  const [[x1, y1], [x2, y2]] = arrow;
  // Head sized off the image width so both screenshots draw the same-sized arrow on screen.
  const head = width * 0.06;
  const len = Math.hypot(x2 - x1, y2 - y1);
  const [ux, uy] = [(x2 - x1) / len, (y2 - y1) / len];
  const [bx, by] = [x2 - ux * head, y2 - uy * head];
  const wing = head * 0.6;
  const headPoints = `${x2},${y2} ${bx - uy * wing},${by + ux * wing} ${bx + uy * wing},${by - ux * wing}`;
  const stroke = { stroke: "var(--hit)", strokeWidth: 2.5, vectorEffect: "non-scaling-stroke", fill: "none" } as const;
  // A dark halo under the arrow, so it reads on light and dark parts of the window alike.
  const halo = { stroke: "rgba(0,0,0,0.7)", strokeWidth: 8, vectorEffect: "non-scaling-stroke", strokeLinecap: "round", strokeLinejoin: "round" } as const;

  return (
    <div
      style={{
        position: "relative",
        maxWidth: "420px",
        lineHeight: 0,
        border: "1px solid var(--panel-border)",
        borderRadius: "6px",
        overflow: "hidden",
      }}
    >
      <img
        src={`${import.meta.env.BASE_URL}${src}`}
        alt={alt}
        width={width}
        height={height}
        loading="lazy"
        style={{ display: "block", width: "100%", height: "auto" }}
      />
      <svg
        aria-hidden
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      >
        {"circle" in ring ? (
          <circle cx={ring.circle[0]} cy={ring.circle[1]} r={ring.r} {...stroke} />
        ) : (
          <rect x={ring.rect[0]} y={ring.rect[1]} width={ring.rect[2]} height={ring.rect[3]} rx={8} {...stroke} />
        )}
        <line x1={x1} y1={y1} x2={bx} y2={by} {...halo} />
        <polygon points={headPoints} {...halo} fill="rgba(0,0,0,0.7)" />
        <line x1={x1} y1={y1} x2={bx} y2={by} {...stroke} strokeWidth={4.5} strokeLinecap="round" />
        <polygon points={headPoints} fill="var(--hit)" />
      </svg>
    </div>
  );
}
