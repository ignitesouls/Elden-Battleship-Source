import { useEffect, useState, type ReactNode } from "react";
import {
  fetchIngestToken,
  createIngestToken,
  regenerateIngestToken,
  autoFireSupported,
  configBlock,
  ingestUrl,
  maskToken,
} from "../lib/autoFire";
import { SQUARE_SET_LIST } from "../lib/squareSets";

/**
 * Where a player sets up auto-marking: mint a token, copy it into the game mod, replace it if it
 * leaks - and, behind a disclosure, the whole "get this working" walkthrough.
 *
 * -- Why this lives on the profile page --------------------------------------------------------
 *
 * The token is per-person and permanent - it encodes no room, no team and no match, because all
 * three are resolved server-side at the moment a kill lands. So it belongs with identity rather
 * than with any one game. Paste it into the mod's config once and it keeps working across every
 * room, fleet and match afterwards.
 *
 * -- Why it is shown masked ----------------------------------------------------------------------
 *
 * Not because it is dangerous - the worst a leaked token can do is fire shots on your behalf in
 * whatever room you happen to be in, and it grants no reads at all. It is masked because this page
 * is the one people screenshot to show off a career, and a secret that only appears when asked for
 * cannot end up in someone's highlight reel by accident.
 *
 * -- Why the guide is collapsed ------------------------------------------------------------------
 *
 * Setting this up is a once-ever job and most profile visits are not it. Somebody who already has
 * the mod running wants the token controls and nothing else, so the install walkthrough is one
 * click away rather than eight paragraphs of wall between them and their career stats.
 */

/**
 * TODO(release): no published build carries auto-fire yet.
 *
 * The mod side lives on `ignitesouls/er-overlay`, branch `autofire` - pushed, verified end to end
 * against the live endpoint, but unmerged and untagged. Linking the current latest release would
 * send people to a build that silently lacks the feature and leaves them debugging a config that
 * was never going to do anything, so there is deliberately no download link until there is a
 * release worth pointing at. Set this to the tagged release URL and the placeholder note in step
 * one disappears on its own.
 */
const MOD_RELEASE_URL: string | null = null;

/** The repository, which is public and correct to name even while the release is not. */
const MOD_REPO_URL = "https://github.com/ignitesouls/er-overlay";

/**
 * TODO(dionysus): when auto-marking ships bundled inside Dionysus Arcade, this guide gets shorter.
 *
 * Right now players install the overlay by hand into the Elden Casual Modes pack they already have,
 * which is why steps one and two exist at all and why the token is handed over as a whole `[ingest]`
 * block - their config arrives with both values blank. Once Arcade carries the DLL with the URL
 * already filled in, steps one and two collapse into "install Dionysus Arcade", the copy control
 * becomes a bare-token copy, and the duplicate-table warning matters more rather than less.
 */
const PACK_NAME = "Elden Casual Modes";

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
        Kill a boss in game and its square fires itself, with the kill time the game saw rather than
        however long it took you to alt-tab. Boss boards only - the objectives sets can't be detected.
      </span>

      {token === null ? (
        <>
          <button onClick={() => void run(createIngestToken)} disabled={busy} style={{ fontSize: "0.78rem" }}>
            {busy ? "Setting up..." : "Set up auto-marking"}
          </button>
          <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
            Gives you a token to paste into the Elden Ring overlay mod's config file, once. You'll
            need the mod installed for it to do anything.
          </span>
        </>
      ) : (
        <>
          {/* The whole block rather than the bare token: the endpoint URL is the other half of the
              setup, and handing over one without the other leaves somebody holding a secret with no
              idea where it goes. See TODO(dionysus) - this becomes a bare-token copy once the pack
              ships a config with the URL already in it. */}
          <textarea
            readOnly
            value={revealed ? configBlock(token) : `[ingest]\nurl   = "..."\ntoken = "${maskToken(token)}"\n`}
            onFocus={(e) => revealed && e.currentTarget.select()}
            rows={3}
            spellCheck={false}
            style={{ fontFamily: "monospace", fontSize: "0.7rem", width: "100%", resize: "vertical" }}
          />

          <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
            <button onClick={() => setRevealed((r) => !r)} style={{ fontSize: "0.74rem" }}>
              {revealed ? "Hide" : "Reveal"}
            </button>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(configBlock(token));
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
              The old token stops working immediately. You'll need to paste the new one into the mod
              before it can mark anything again.
            </span>
          )}

          <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
            Paste into the mod's config file. Anyone holding this token can fire shots as you in
            whatever room you're playing in - it can't read anything or touch anything else, but
            replace it if it gets out.
          </span>
        </>
      )}

      {error && (
        <span className="error-text" style={{ fontSize: "0.7rem" }}>
          {error}
        </span>
      )}

      {/* Offered whether or not a token exists: someone who has never pressed the button deserves
          to see what they are signing up for before they mint a secret, and someone whose squares
          stopped filling in is here to re-read step four. */}
      <button
        onClick={() => setGuideOpen((o) => !o)}
        aria-expanded={guideOpen}
        style={{ fontSize: "0.74rem", alignSelf: "flex-start" }}
      >
        {guideOpen ? "▾" : "▸"} How to set it up in game
      </button>

      {guideOpen && <SetupGuide hasToken={token !== null} />}
    </div>
  );
}

/**
 * The install walkthrough.
 *
 * Every exact string in here - the config filename, the `[[natives]]` line, the overlay's own
 * status lines - matches the mod rather than describing it approximately. A wrong detail in this
 * section costs somebody an hour of staring at a config file that looks right.
 *
 * The folder tree is anchored on the pack players already have rather than on an abstract me3
 * install, because "next to your .me3 profile" is only obvious to someone who already knows where
 * that is - and the people who need this guide are exactly the people who don't.
 */
function SetupGuide({ hasToken }: { hasToken: boolean }) {
  /**
   * Which boards this can work on, asked of the same predicate the room screen uses rather than
   * written out here. If a future set ever becomes flag-detectable, this line follows it.
   */
  const supportedBoards = SQUARE_SET_LIST.filter((s) => autoFireSupported(s.id)).map((s) => s.label);

  /** Named so a player behind a firewall knows what to let through. */
  const endpointHost = hostOf(ingestUrl());

  return (
    <div className="stack" style={{ gap: "0.7rem", paddingTop: "0.2rem" }}>
      <Step n={1} title="Get the mod">
        <p style={body}>
          Auto-marking is a feature of the Ignite overlay, a native mod for Elden Ring loaded through{" "}
          <strong>me3</strong> - the same loader <strong>{PACK_NAME}</strong> already uses. It watches
          the game's own event flags, spots a boss die and reports it. The website never reads your
          game and the mod never reads the website; the only traffic is the mod posting kills to{" "}
          <code style={code}>{endpointHost}</code>.
        </p>
        {MOD_RELEASE_URL ? (
          <p style={body}>
            <a href={MOD_RELEASE_URL} target="_blank" rel="noreferrer">
              Download the latest release
            </a>{" "}
            and unzip it. You'll want the <code style={code}>er_overlay.dll</code>, its{" "}
            <code style={code}>.toml</code> config and the <code style={code}>data</code> folder.
          </p>
        ) : (
          /* Deliberately not a link. See MOD_RELEASE_URL. */
          <Warn>
            There is no released build with auto-marking in it yet. The code is public and working on
            the <code style={code}>autofire</code> branch of{" "}
            <a href={MOD_REPO_URL} target="_blank" rel="noreferrer">
              ignitesouls/er-overlay
            </a>
            , but it is unmerged and untagged - the current release does <em>not</em> have this
            feature, and installing it will get you an overlay that never fires anything. Wait for the
            build that names auto-marking in its notes.
          </Warn>
        )}
      </Step>

      <Step n={2} title={`Drop it into ${PACK_NAME}`}>
        <p style={body}>
          Under me3 each native mod sits in its own folder next to the <code style={code}>.me3</code>{" "}
          profile you launch with. In {PACK_NAME} that's inside{" "}
          <code style={code}>Resources</code>, alongside the mods already there - make a new{" "}
          <code style={code}>EROverlay</code> folder and put the three files in it:
        </p>
        <Pre>{`${PACK_NAME}\\
└─ Resources\\
   └─ me3-v0.8.0\\
      ├─ eldenring-basedlc.me3       <- the profile
      ├─ StutterFix\\
      ├─ RandomizerHelper\\
      └─ EROverlay\\                  <- make this one
         ├─ er_overlay.dll
         ├─ ignite_overlay_config.toml
         └─ data\\engus\\bosses.json`}</Pre>
        <p style={body}>
          Then one line at the end of <code style={code}>eldenring-basedlc.me3</code>, opened in any
          text editor, so the profile actually loads the DLL:
        </p>
        <Pre>{`[[natives]]
path = 'EROverlay/er_overlay.dll'`}</Pre>
        <p style={body}>
          Paths there are relative to the <code style={code}>.me3</code> file's own folder, not to the
          game's - which is why that line is just{" "}
          <code style={code}>EROverlay/er_overlay.dll</code> and not the whole path from your desktop.
        </p>
        <p style={body}>
          Rerolling doesn't undo this. The randomizer loads as a <code style={code}>[[package]]</code>,
          a separate mechanism from natives, and the launcher never rewrites the profile - so a native
          you add by hand survives every reroll.
        </p>
      </Step>

      <Step n={3} title="Paste your token into the config">
        <p style={body}>
          Open <code style={code}>ignite_overlay_config.toml</code> - the one sitting next to{" "}
          <code style={code}>er_overlay.dll</code>. The DLL has that filename compiled into it and
          looks only in its own folder, so it can't be renamed or moved: rename it and the mod loads
          with no configuration at all.
        </p>
        <p style={body}>
          {hasToken
            ? "Press Copy config above and paste the block in. It looks like this:"
            : "Press Set up auto-marking above to mint your token, then Copy config. The block looks like this:"}
        </p>
        <Pre>{`[ingest]
url   = "https://.../functions/v1/auto-fire"
token = "your token"`}</Pre>
        <Warn>
          The file already has an empty <code style={code}>[ingest]</code> section in it, so{" "}
          <strong>replace that one</strong> - don't paste a second at the bottom. TOML forbids
          duplicate tables, so the mod would fail to read its config at all and you'd silently lose the
          overlay along with the marking.
        </Warn>
        <p style={body}>
          Both values are required. The mod ships with the two of them blank and does nothing
          whatsoever until they're both filled in - it makes no network requests at all in that state.
        </p>
        <p style={body}>
          Optional, under the existing <code style={code}>[overlay]</code> section, if you want the
          running tally on screen: <code style={code}>show_ingest_tally = true</code>. It's already the
          default, so you only need this if you turned it off.
        </p>
      </Step>

      <Step n={4} title="Check that it worked">
        <p style={body}>
          Start a match here with an opposing team seated, then load into the game. The overlay's
          auto-fire line tells you exactly where you are:
        </p>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.68rem" }}>
          <tbody>
            <Row on="(no line at all)" dim>
              Not in a live match, or this lobby's board isn't a supported one. Normal.
            </Row>
            <Row on="Hit 0   Miss 0   Total 0   Acc -">
              Connected, match live, no shots yet. <strong>This is the "it works" signal.</strong>
            </Row>
            <Row on="Hit 8   Miss 4   Total 12   Acc 67%">
              Working. The numbers come from the server, so they match this site exactly.
            </Row>
            <Row on="Autofire [!] bad token" bad>
              Token missing, mistyped or replaced since you pasted it.
            </Row>
            <Row on="Autofire [!] in 2 live matches" bad>
              You're seated in two rooms that are both still in battle. See below.
            </Row>
            <Row on="Autofire [!] no connection" bad>
              Can't reach <code style={code}>{endpointHost}</code>.
            </Row>
            <Row on="Autofire connected">
              Accepted, but the reply carried no tally. Rare.
            </Row>
          </tbody>
        </table>
        <p style={body}>
          <code style={code}>[!]</code> always means the last report didn't land. Press{" "}
          <code style={code}>=</code> in game to expand the overlay and read the raw error code -
          that's the thing to quote if you report it.
        </p>
      </Step>

      <Step n={5} title="If squares aren't filling in">
        <ul style={{ ...body, margin: 0, paddingLeft: "1.1rem" }}>
          <li style={li}>
            <strong>Start the match.</strong> Sitting in the lobby with a board on screen isn't enough
            - kills are ignored until firing actually opens.
          </li>
          <li style={li}>
            <strong>An opposing team has to be seated.</strong> With nobody to shoot at, a kill has
            nowhere to go and is skipped.
          </li>
          <li style={li}>
            <strong>Bosses already dead on that save report the moment the mod loads.</strong> Any of
            them that happen to be squares on your board fire immediately, which looks like a bug and
            isn't one. Use a fresh character if you want a clean run.
          </li>
          <li style={li}>
            <strong>End your matches, don't just leave them.</strong> Leaving a room doesn't end it,
            and two live seats is what produces <code style={code}>in 2 live matches</code> - the mod
            can't tell which board you mean, so nothing fires in either.
          </li>
          <li style={li}>
            <strong>{supportedBoards.join(", ")} boards only.</strong> The objectives sets are counters
            and judgement calls that no event flag can settle, so auto-marking doesn't appear on them
            at all.
          </li>
          <li style={li}>
            <strong>Your language doesn't matter.</strong> Reports carry flag ids, never names, and
            every localized boss list holds the same flags. Setting{" "}
            <code style={code}>language = "frafr"</code> changes what the boss list reads like and
            nothing else.
          </li>
          <li style={li}>
            <strong>It fails safe.</strong> If the mod doesn't load, can't reach the network or reads
            nothing at all, no square marks itself and you click it by hand exactly as before. It
            never blocks or interferes with the game.
          </li>
        </ul>
      </Step>

      <Step n={6} title="Keeping your token yours">
        <ul style={{ ...body, margin: 0, paddingLeft: "1.1rem" }}>
          <li style={li}>
            It's personal and permanent. Paste it once and it survives new rooms, new teams and new
            matches - there's nothing to update between games.
          </li>
          <li style={li}>
            Anyone holding it can fire shots as you in whatever match you're in. It can't read
            anything and can't touch anything else.
          </li>
          <li style={li}>
            <strong>Never share a config file with your token in it.</strong> Handing someone your
            working setup folder is the obvious way to help them and the single most likely way a
            token leaks - send them here instead.
          </li>
          <li style={li}>
            <strong>Replace</strong> above invalidates the old one immediately, so a leak costs you one
            paste rather than anything worse.
          </li>
        </ul>
      </Step>
    </div>
  );
}

const body = { fontSize: "0.7rem", lineHeight: 1.45, margin: 0 } as const;
const li = { marginBottom: "0.3rem" } as const;
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

/** Fixed-width, horizontally scrollable: folder trees and TOML must not rewrap on a phone. */
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

/** The two things that quietly break a setup rather than announcing it, in the colour of a hit. */
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

function Row({ on, children, dim, bad }: { on: string; children: ReactNode; dim?: boolean; bad?: boolean }) {
  return (
    <tr style={{ borderTop: "1px solid var(--panel-border)" }}>
      <td
        style={{
          fontFamily: "monospace",
          whiteSpace: "pre",
          padding: "0.3rem 0.5rem 0.3rem 0",
          verticalAlign: "top",
          color: bad ? "var(--hit)" : dim ? "var(--text-dim)" : "var(--text)",
        }}
      >
        {on}
      </td>
      <td style={{ padding: "0.3rem 0", verticalAlign: "top", lineHeight: 1.4 }}>{children}</td>
    </tr>
  );
}

/** The endpoint's host alone - a whole function URL in running prose is noise. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
