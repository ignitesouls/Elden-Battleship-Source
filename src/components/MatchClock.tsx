import { formatDuration } from "../lib/matchTime";
import { useBattleClock } from "../hooks/useBattlePhase";
import type { Attack, Room } from "../types/battleship";
import { useT } from "../lib/language";

interface Props {
  attacks: Attack[];
  room?: Room | null;
  /** Must match the maxVh/maxVw passed to the "Your fleet" BoardGrid below this, so the two boxes line up at the same width. */
  maxVh?: number;
  maxVw?: number;
  /** One line instead of a card, for a bar. Used by the spectator screen. */
  compact?: boolean;
}

// The first window is where the board is dealt against the fleets standing on it (see
// lib/boardBalance.ts), and where the squares are still blank because of it. Named for what is
// happening rather than for the fact that something is: the phase key stays `starting`, since
// renaming it would churn matchTime, useBattlePhase and every consumer to change one word on screen.
const PHASE_LABEL = {
  starting: "Randomization",
  preparation: "Preparation",
  match: "Match",
} as const;

/**
 * What the label says instead while the match is stopped - see lib/matchPause.
 *
 * The label rather than the digits, because the digits are already telling the truth: a frozen clock
 * is what a pause IS, and battlePhaseAt holds them at the instant the freeze began. What they cannot
 * say on their own is WHY they have stopped, and a clock that has stopped for no visible reason is
 * indistinguishable from a clock that has broken - which is the one reading this must never give.
 *
 * `pausing` is not in here on purpose: during the warning window the clock is genuinely still
 * running, and relabelling it would claim otherwise. The banner over the boards is carrying that
 * countdown, and it is carrying the sentence that goes with it.
 */
const PAUSE_LABEL = {
  paused: "Paused",
  resuming: "Resuming",
} as const;

export function MatchClock({ attacks, room, maxVh = 34, maxVw = 26, compact }: Props) {
  const t = useT();
  // The one component on the match screen that genuinely draws seconds, and so the one that takes
  // the ticking hook. Everything else reads the phase name instead - see useBattlePhase.
  const info = useBattleClock(attacks, room);
  const stopped = info && info.pause.phase !== "running" && info.pause.phase !== "pausing";
  const TR_PHASE_LABEL: Record<keyof typeof PHASE_LABEL, string> = {
    starting: t("Randomization", "Randomisation"),
    preparation: t("Preparation", "Préparation"),
    match: t("Match", "Match"),
  };
  const TR_PAUSE_LABEL: Record<keyof typeof PAUSE_LABEL, string> = {
    paused: t("Paused", "En pause"),
    resuming: t("Resuming", "Reprise"),
  };
  const label = stopped
    ? TR_PAUSE_LABEL[info.pause.phase as keyof typeof PAUSE_LABEL]
    : info
      ? TR_PHASE_LABEL[info.phase]
      : t("Match", "Match");
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
        <span className="spectate-clock-phase">{info ? label : (room?.status ?? t("waiting", "en attente"))}</span>
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
