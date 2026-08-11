import { formatDuration } from "../lib/matchTime";
import { useBattlePhase } from "../hooks/useBattlePhase";
import type { Attack, Room } from "../types/battleship";

interface Props {
  attacks: Attack[];
  room?: Room | null;
  /** Must match the maxVh/maxVw passed to the "Your fleet" BoardGrid below this, so the two boxes line up at the same width. */
  maxVh?: number;
  maxVw?: number;
  /** One line instead of a card, for a bar. Used by the spectator screen. */
  compact?: boolean;
}

const PHASE_LABEL = {
  starting: "Starting",
  preparation: "Preparation",
  match: "Match",
} as const;

export function MatchClock({ attacks, room, maxVh = 34, maxVw = 26, compact }: Props) {
  const info = useBattlePhase(attacks, room);
  const label = info ? PHASE_LABEL[info.phase] : "Match";
  // STARTING/PREPARATION count down toward zero, so they read as negative time; MATCH counts up.
  const display = info
    ? info.phase === "match"
      ? formatDuration(info.matchElapsed)
      : `-${formatDuration(info.countdown)}`
    : "--:--";

  /**
   * Bar form.
   *
   * Before the start marker exists there is nothing to count, so this names the phase the room is
   * actually in and shows no digits - the card form is hidden entirely in that state, but a bar
   * that a caster is relying on should keep its slot rather than appearing partway through a match.
   * A blinking "--:--" is what reads as a broken clock; "Placement" with no clock does not.
   */
  if (compact) {
    return (
      <span className="spectate-clock">
        <span className="spectate-clock-phase">{info ? label : (room?.status ?? "waiting")}</span>
        {info && <span className="spectate-clock-time">{display}</span>}
      </span>
    );
  }

  return (
    <div
      className="panel"
      style={{
        width: `min(${maxVh}vh, ${maxVw}vw, 1600px)`,
        textAlign: "center",
        padding: "0.4rem 0.8rem",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "0.1rem",
      }}
    >
      {/* Phase label gets the display face; the digits below deliberately don't - see index.css. */}
      <span
        className="muted display"
        style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.18em" }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: "clamp(1.8rem, 4.5vh, 3.2rem)",
          fontWeight: 700,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "0.02em",
        }}
      >
        {display}
      </span>
    </div>
  );
}
