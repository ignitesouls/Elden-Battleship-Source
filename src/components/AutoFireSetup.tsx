import { useEffect, useState, type ReactNode } from "react";
import {
  fetchIngestToken,
  createIngestToken,
  regenerateIngestToken,
  configFile,
  maskToken,
} from "../lib/autoFire";
import { CONFIG_FILENAME } from "../lib/overlayConfig";

/**
 * Where a player sets up auto-marking: mint a token, copy it into the game mod, replace it if it
 * leaks, and, behind a disclosure, four steps for getting it running.
 *
 * -- Why this lives on the profile page --------------------------------------------------------
 *
 * The token is per-person and permanent: it encodes no room, no team and no match, because all
 * three are resolved server-side at the moment a kill lands. So it belongs with identity rather
 * than with any one game. Paste it into the mod's config once and it keeps working across every
 * room, fleet and match afterwards.
 *
 * -- Why it is shown masked ----------------------------------------------------------------------
 *
 * Not because it is dangerous. The worst a leaked token can do is fire shots on your behalf in
 * whatever room you happen to be in, and it grants no reads at all. It is masked because this page
 * is the one people screenshot to show off a career, and a secret that only appears when asked for
 * cannot end up in someone's highlight reel by accident.
 *
 * -- Why the guide is four steps -----------------------------------------------------------------
 *
 * It used to talk players through creating a mod folder, editing an me3 profile and surgically
 * replacing one table inside a TOML file, and then spent three more sections on what to do when
 * that went wrong. All of it was accurate and most people could not follow it. Dionysus now ships
 * the overlay already installed, so the only thing left to do is overwrite one file: copy, select
 * all, paste, save. Nothing that can go wrong halfway is left in that path, so nothing here
 * explains how to recover from it. Anyone still stuck belongs on the support page rather than in a
 * table of overlay status lines.
 */

export function AutoFireSetup() {
  /** `undefined` while loading, `null` when the player has never made one. */
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [revealed, setRevealed] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
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
      <strong style={{ fontSize: "0.82rem" }}>Auto-marking</strong>

      <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.4 }}>
        Kill a boss in game and its square fires itself. The game supplies the kill time, so it
        doesn't matter how long you take to alt-tab. Boss boards only - Objectives can't be detected.
      </span>

      {token === null ? (
        <>
          <button onClick={() => void run(createIngestToken)} disabled={busy} style={{ fontSize: "0.78rem" }}>
            {busy ? "Setting up..." : "Set up auto-marking"}
          </button>
          <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
            You paste a config file into Dionysus, once.
          </span>
        </>
      ) : (
        <>
          {/* The whole file, not the bare token. Everything about this panel points at one action:
              overwrite one file with this. A preview showing three lines would invite somebody to
              paste three lines into the middle of a config instead, and lose the overlay to a
              duplicate [ingest] table. Masked, it shows only the lines worth checking. */}
          <textarea
            readOnly
            value={revealed ? configFile(token) : `[ingest]\nurl = "..."\ntoken = "${maskToken(token)}"\n`}
            onFocus={(e) => revealed && e.currentTarget.select()}
            rows={revealed ? 8 : 3}
            spellCheck={false}
            style={{ fontFamily: "monospace", fontSize: "0.7rem", width: "100%", resize: "vertical" }}
          />

          <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
            <button onClick={() => setRevealed((r) => !r)} style={{ fontSize: "0.74rem" }}>
              {revealed ? "Hide" : "Reveal"}
            </button>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(configFile(token));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              style={{ fontSize: "0.74rem" }}
            >
              {copied ? "Copied" : "Copy config"}
            </button>

            {/* Two clicks, because the first one is irreversible and silent: the old token stops
                working immediately, and the only symptom is that somebody's mod quietly stops
                marking squares mid-session. */}
            {confirmingReset ? (
              <>
                <button
                  onClick={() => void run(regenerateIngestToken)}
                  disabled={busy}
                  style={{ fontSize: "0.74rem", borderColor: "var(--hit)" }}
                >
                  {busy ? "Replacing..." : "Yes, replace it"}
                </button>
                <button onClick={() => setConfirmingReset(false)} style={{ fontSize: "0.74rem" }}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmingReset(true)}
                style={{ fontSize: "0.74rem" }}
                title="Replaces the token. The old one stops working straight away."
              >
                Replace
              </button>
            )}
          </div>

          {confirmingReset && (
            <span style={{ fontSize: "0.68rem", lineHeight: 1.35, color: "var(--hit)" }}>
              The old token stops working immediately. Paste the new config into Dionysus before it
              can mark anything again.
            </span>
          )}

          <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
            Your token is in that config. Anyone who has it can fire shots as you. It can't read or
            change anything else, but replace it if it gets out.
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
        {guideOpen ? "▾" : "▸"} How to set it up in game
      </button>

      {guideOpen && <SetupGuide />}
    </div>
  );
}

/**
 * Four steps and one warning.
 *
 * The filename and the folder tree match a real Dionysus install rather than describing one
 * approximately, because the whole guide now rests on somebody finding one file. Anything vague
 * here is the whole thing failing.
 */
function SetupGuide() {
  return (
    <div className="stack" style={{ gap: "0.7rem", paddingTop: "0.2rem" }}>
      <Step n={1} title="Get the latest Dionysus">
        <p style={body}>Auto-marking needs an up-to-date Dionysus. Check for updates first.</p>
      </Step>

      <Step n={2} title="Open the config file">
        <p style={body}>It's in your Dionysus folder:</p>
        <Pre>{`Dionysus\\
└─ Resources\\
   └─ me3-v0.8.0\\
      └─ EROverlay\\
         └─ ${CONFIG_FILENAME}      <- open this one`}</Pre>
        <p style={body}>Open it with Notepad.</p>
      </Step>

      <Step n={3} title="Replace everything in it">
        <p style={body}>
          Press <strong>Copy config</strong> above. Click inside the file, press{" "}
          <code style={code}>Ctrl+A</code>, then <code style={code}>Ctrl+V</code>.
        </p>
      </Step>

      <Step n={4} title="Save">
        <p style={body}>
          <code style={code}>Ctrl+S</code>. That's it. Bosses you kill in game now mark your squares.
        </p>
      </Step>

      <Warn>Your token is in that file now. Don't send the file to anyone.</Warn>
    </div>
  );
}

const body = { fontSize: "0.7rem", lineHeight: 1.45, margin: 0 } as const;
const code = {
  fontFamily: "monospace",
  fontSize: "0.94em",
  background: "#061620",
  padding: "0.05rem 0.25rem",
  borderRadius: "4px",
} as const;

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

/** Fixed-width, horizontally scrollable: a folder tree must not rewrap on a phone. */
function Pre({ children }: { children: string }) {
  return (
    <pre
      style={{
        fontFamily: "monospace",
        fontSize: "0.66rem",
        lineHeight: 1.5,
        background: "#061620",
        border: "1px solid var(--panel-border)",
        borderRadius: "6px",
        padding: "0.5rem 0.6rem",
        margin: 0,
        overflowX: "auto",
      }}
    >
      {children}
    </pre>
  );
}

/** The one warning said twice, in the colour of a hit. */
function Warn({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        ...body,
        color: "var(--hit)",
        borderLeft: "2px solid var(--hit)",
        paddingLeft: "0.5rem",
      }}
    >
      {children}
    </p>
  );
}
