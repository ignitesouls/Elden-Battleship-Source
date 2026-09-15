import { useState } from "react";
import { formatRoomCode } from "../lib/roomCode";
import { useT } from "../lib/language";

interface Props {
  roomCode: string;
  seed?: string | null;
  rejoinCode?: string | null;
  /** Flat chips on one line, for the dock along the bottom of the match screen. */
  inline?: boolean;
  /**
   * Whether this match counts for nothing - see Room.practice.
   *
   * It rides along here because this box is the one thing on screen for the whole match, in every
   * phase and in both layouts, and a practice match has to keep saying so. The lobby announces it
   * once in the settings panel, which is a screen people are on for about forty seconds; nobody who
   * joined late, or who is spectating, or who came back from a tab, ever saw that.
   */
  practice?: boolean;
}

/** What the marker says, in the two places it is drawn. Kept in one place so they cannot drift. */
function practiceHint(t: (en: string, fr: string) => string): string {
  return t(
    "Practice match - nothing here reaches the leaderboard, careers or records.",
    "Partie d'entraînement - rien ici n'est pris en compte pour le classement, les carrières ou les records."
  );
}

/** The rejoin code's warning, which the bar form has no room to print. Kept here so both say it. */
function rejoinHint(t: (en: string, fr: string) => string): string {
  return t(
    "Copy the rejoin code now. It's what gets your fleet back on another device, or after you " +
      "clear your cache. Signing in with Twitch does the same for you.",
    "Copiez le code de reconnexion maintenant. C'est ce qui récupère votre flotte sur un autre appareil, ou " +
      "après avoir vidé votre cache. Se connecter avec Twitch fait la même chose pour vous."
  );
}

/**
 * Room code, randomizer seed and rejoin code, parked at the bottom of the match screen.
 *
 * The rejoin code lived in the lobby, which was the wrong place for it. A rejoin code is only any
 * use if you already copied it BEFORE you needed it - and the lobby is a screen people pass
 * through in a few seconds on the way to placing ships. Anyone disconnecting mid-match had, in
 * practice, never seen it.
 *
 * It can't be recovered after the fact either: the browser only remembers which player row it owns
 * in localStorage, so the situations the code exists for - a different device, a cleared cache -
 * are exactly the ones where that lookup is already gone. Signing in with Twitch is the real fix,
 * because it binds the row to a durable identity; the code is the fallback for everyone else, and
 * it has to be somewhere you'll be sitting for the next twenty minutes.
 */
export function MatchInfoBox({ roomCode, seed, rejoinCode, inline, practice }: Props) {
  const t = useT();
  const PRACTICE_HINT = practiceHint(t);
  const REJOIN_HINT = rejoinHint(t);
  const [copied, setCopied] = useState<string | null>(null);

  function copy(label: string, value: string) {
    navigator.clipboard?.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }

  /**
   * Bar form: each field is one chip you click to copy, rather than a label/value/button row.
   *
   * The whole chip is the button because at this size a separate "Copy" next to a five-character
   * code is mostly button. The rejoin warning becomes that chip's tooltip - a bar has nowhere to
   * print two lines of prose, and dropping it outright would take away the one thing that makes
   * the code useful, which is knowing to copy it BEFORE you need it.
   */
  if (inline) {
    const chip = (key: string, label: string, value: string, accent: boolean, title?: string) => (
      <button
        key={key}
        type="button"
        className={`match-info-chip${accent ? " match-info-chip-accent" : ""}`}
        onClick={() => copy(key, value)}
        title={title ?? t(`Copy ${label.toLowerCase()}`, `Copier ${label.toLowerCase()}`)}
      >
        <span className="match-info-chip-label">{label}</span>
        <code className="match-info-chip-value">{value}</code>
        <span className="match-info-chip-copy" aria-hidden>
          {copied === key ? "✓" : "⧉"}
        </span>
      </button>
    );

    return (
      <div className="match-info-inline">
        {/* First in the row, ahead of the room code: it is the one thing here that changes what the
            next hour is worth, and a bar is read left to right. */}
        {practice && (
          <span className="match-info-practice" title={PRACTICE_HINT}>
            {t("Practice", "Entraînement")}
          </span>
        )}
        {chip("room", t("Room", "Salle"), formatRoomCode(roomCode), true)}
        {seed && chip("seed", t("Seed", "Graine"), seed, false)}
        {rejoinCode && chip("rejoin", t("Rejoin", "Reconnexion"), rejoinCode, true, REJOIN_HINT)}
      </div>
    );
  }

  const row: React.CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "0.4rem",
  };
  const value: React.CSSProperties = {
    fontSize: "0.85rem",
    letterSpacing: "0.06em",
    color: "var(--accent)",
    minWidth: 0,
    overflowWrap: "anywhere",
  };
  const btn: React.CSSProperties = { fontSize: "0.65rem", padding: "0.1rem 0.35rem", flex: "none" };

  return (
    <div className="panel stack" style={{ gap: "0.3rem", padding: "0.5rem 0.6rem" }}>
      {/* The card form has room for the whole sentence, so it prints it rather than leaning on a
          tooltip nobody hovers. Above the room code for the same reason it leads the bar. */}
      {practice && (
        <span style={{ fontSize: "0.68rem", lineHeight: 1.3, color: "var(--hit)" }}>{PRACTICE_HINT}</span>
      )}
      <div style={row}>
        <span className="muted" style={{ fontSize: "0.7rem" }}>{t("Room", "Salle")}</span>
        <code style={value}>{formatRoomCode(roomCode)}</code>
        <button style={btn} onClick={() => copy("room", formatRoomCode(roomCode))}>
          {copied === "room" ? "✓" : t("Copy", "Copier")}
        </button>
      </div>

      {seed && (
        <div style={row}>
          <span className="muted" style={{ fontSize: "0.7rem" }}>{t("Seed", "Graine")}</span>
          <code style={{ ...value, color: "var(--text)" }}>{seed}</code>
          <button style={btn} onClick={() => copy("seed", seed)}>
            {copied === "seed" ? "✓" : t("Copy", "Copier")}
          </button>
        </div>
      )}

      {rejoinCode && (
        <>
          <div style={row}>
            <span className="muted" style={{ fontSize: "0.7rem" }}>{t("Rejoin", "Reconnexion")}</span>
            <code style={value}>{rejoinCode}</code>
            <button style={btn} onClick={() => copy("rejoin", rejoinCode)}>
              {copied === "rejoin" ? "✓" : t("Copy", "Copier")}
            </button>
          </div>
          <span className="muted" style={{ fontSize: "0.62rem", lineHeight: 1.3 }}>{REJOIN_HINT}</span>
        </>
      )}
    </div>
  );
}
