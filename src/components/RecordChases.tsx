import { teamHex } from "../lib/teamColors";
import type { RecordChase } from "../lib/recordChase";
import { useT } from "../lib/language";

interface Props {
  chases: RecordChase[];
  /** True on a caster's screen, where chases from every fleet are shown and need naming by colour. */
  showTeams?: boolean;
  title?: string;
}

/**
 * Records in play, while the match is still running.
 *
 * Renders nothing at all when nobody is close, which is most of the time - a panel that is always
 * present but usually says "nothing" trains people to stop looking at it, and the whole value here is
 * that its appearance means something.
 *
 * A broken record gets the accent colour and reads as done; a chase stays quiet and states the gap,
 * because the useful sentence mid-match is "two more hits", not "you are on 17".
 */
export function RecordChases({ chases, showTeams, title }: Props) {
  const t = useT();
  if (chases.length === 0) return null;

  return (
    <div className="panel stack" style={{ gap: "0.35rem", padding: "0.5rem 0.6rem" }}>
      <span className="muted" style={{ fontSize: "0.7rem", letterSpacing: "0.06em", textTransform: "uppercase" }}>
        {title ?? t("Records in play", "Records en cours")}
      </span>
      {chases.map((c) => (
        <div
          key={`${c.recordId}-${c.key}`}
          className="row"
          style={{ gap: "0.45rem", alignItems: "baseline", fontSize: "0.78rem" }}
        >
          <span aria-hidden style={{ flexShrink: 0 }}>{c.emoji}</span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <strong style={{ color: showTeams ? teamHex(c.team) : "var(--text)" }}>{c.nickname}</strong>
            <span className="muted"> · {c.label}</span>
            <div
              style={{
                fontSize: "0.72rem",
                color: c.state === "broken" ? "var(--accent)" : "var(--text-dim)",
                fontWeight: c.state === "broken" ? 600 : 400,
              }}
            >
              {c.display}
            </div>
          </span>
        </div>
      ))}
    </div>
  );
}
