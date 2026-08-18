import { useEffect, useState } from "react";
import {
  fetchFairnessGaps,
  fairnessOf,
  fairnessBand,
  strandedFleets,
  durationSeconds,
  gapLabel,
  ordinal,
  type MatchBalance,
} from "../lib/matchBalance";

/**
 * How fair the board was, on the recap.
 *
 * Every team fires at the SAME named grid, so which squares sit on which fleet's cells is the entire
 * competitive asymmetry of a match - and until the balancer landed, that was decided by a shuffle
 * struck before anyone had placed a ship. This is the one place a player gets told what that came
 * out as. It reads the number the balancer recorded at the moment it dealt the board; nothing is
 * computed here and no square is ever priced in a browser.
 *
 * -- On not naming a fleet -------------------------------------------------------------------------
 *
 * The stored gap is a magnitude and not a direction: it is the widest same-rank distance between two
 * fleets' ship profiles, which says how far apart they were and cannot say which of them was ahead.
 * So the copy says "the deal was 6:20 apart" and never "favoured Red". Inventing the direction would
 * be the easiest sentence on the page to write and the only one that would be a guess.
 */
export function BalanceReadout({
  balance,
  duration,
  width = "min(560px, 100%)",
}: {
  balance: MatchBalance | null;
  /** The archived duration string, for the stranded-fleet check. `mm:ss` or `h:mm:ss`. */
  duration: string | null;
  width?: string;
}) {
  /**
   * Every other match's gap, for the ranking.
   *
   * Fetched here rather than passed in, so both recaps - the live one and the permanent one - get
   * this by rendering the component and nothing else. It is one narrow column off a table both pages
   * already read, and it is deliberately not awaited before the rest of the panel draws: the gaps
   * are the whole story and the percentile is the gloss on it.
   */
  const [gaps, setGaps] = useState<number[] | null>(null);

  useEffect(() => {
    if (!balance) return;
    let cancelled = false;
    void (async () => {
      const all = await fetchFairnessGaps();
      if (!cancelled) setGaps(all);
    })();
    return () => {
      cancelled = true;
    };
  }, [balance]);

  // No record at all: every match before the balancer, every board on a set with no cost data, and
  // any room where the balancer could not be reached. Nothing honest to say, so nothing is said -
  // an empty fairness panel would imply the match had been scored and found wanting.
  if (!balance) return null;

  const fairness = gaps ? fairnessOf(balance.played, gaps) : null;
  const band = fairnessBand(balance.played, balance.limit);
  const stranded = strandedFleets(balance, durationSeconds(duration));
  // False only on a swept record for a room the balancer never touched. A deal-time record exists
  // BECAUSE the balancer ran, so an absent flag means it ran.
  const unbalanced = balance.hadPerm === false;
  const improved = balance.dealt - balance.played;

  // Both bars scale against the wider of the two, so the shorter one reads as a fraction of the
  // longer at a glance. Against a fixed ceiling every ordinary board would be two short stubs.
  const scale = Math.max(balance.dealt, balance.played, 1);

  return (
    <div className="panel stack" style={{ gap: "0.45rem", width }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", alignItems: "baseline" }}>
        <h3 style={{ margin: 0 }}>Board fairness</h3>
        <span style={{ color: band.color, fontSize: "0.78rem", fontWeight: 600, letterSpacing: "0.04em" }}>
          {band.label}
        </span>
      </div>

      {/* The headline, and the sample right under it. A percentile off eleven matches is a real
          number and a shaky one, and the reader is owed both facts in the same breath. */}
      {fairness ? (
        <div className="stack" style={{ gap: 0 }}>
          <span style={{ fontSize: "1.7rem", fontWeight: 700, lineHeight: 1.1, color: "var(--accent)" }}>
            {ordinal(fairness.percentile)} percentile
          </span>
          <span className="muted" style={{ fontSize: "0.72rem" }}>
            Fairer than {fairness.percentile}% of the {fairness.sample} scored{" "}
            {fairness.sample === 1 ? "match" : "matches"} on record
          </span>
        </div>
      ) : (
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          {gaps === null ? "Ranking this board..." : "Nothing to rank this against yet."}
        </span>
      )}

      <div className="stack" style={{ gap: "0.3rem", marginTop: "0.2rem" }}>
        <GapBar label="The deal was" seconds={balance.dealt} scale={scale} tone="var(--text-dim)" />
        <GapBar
          label={unbalanced ? "Played as dealt" : "The board played"}
          seconds={balance.played}
          scale={scale}
          tone={band.color}
        />
      </div>

      <span className="muted" style={{ fontSize: "0.7rem" }}>
        Seconds between the two fleets at their closest-matched ships - the longest against the
        longest, the shortest against the shortest. Lower is fairer.
      </span>

      <div className="stack" style={{ gap: "0.15rem", fontSize: "0.74rem" }}>
        {unbalanced ? (
          <span className="muted">
            This board was never balanced - the squares fell where the seed put them, which is how
            every match worked before the balancer.
          </span>
        ) : improved > 0 ? (
          <span className="muted">
            The balancer moved the squares and took {gapLabel(improved)} off the gap.
          </span>
        ) : (
          <span className="muted">
            The balancer accepted the layout it drew; the deal was already inside the limit.
          </span>
        )}

        {/* The one number here that decides matches rather than describing them. A wide gap between
            two fleets who both had time to finish is a wide gap; a fleet holding a hull gated longer
            than the match lasted could not have been beaten in the time available. */}
        {stranded !== null && (
          <span style={{ color: stranded > 0 ? "var(--sunk)" : "var(--text-dim)" }}>
            {stranded === 0
              ? "Neither fleet was holding a ship the match ran out of time for."
              : stranded === 1
              ? "One fleet held a ship gated longer than the whole match lasted."
              : `${stranded} fleets held a ship gated longer than the whole match lasted.`}
          </span>
        )}

        {balance.accepted === false && (
          <span style={{ color: "var(--sunk)" }}>
            No layout in the balancer's whole budget met the rules. This was the fairest it found.
          </span>
        )}
      </div>
    </div>
  );
}

/** One measure as a labelled bar. The number is the point; the bar is what makes two comparable. */
function GapBar({
  label,
  seconds,
  scale,
  tone,
}: {
  label: string;
  seconds: number;
  scale: number;
  tone: string;
}) {
  return (
    <div className="row" style={{ gap: "0.5rem", alignItems: "center", fontSize: "0.78rem" }}>
      <span className="muted" style={{ flex: "0 0 8.5rem" }}>{label}</span>
      <div
        style={{
          flex: 1,
          minWidth: "3rem",
          height: "0.5rem",
          borderRadius: 3,
          background: "var(--cell)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.max(2, Math.round((seconds / scale) * 100))}%`,
            height: "100%",
            background: tone,
          }}
        />
      </div>
      <strong style={{ fontVariantNumeric: "tabular-nums", minWidth: "3rem", textAlign: "right" }}>
        {gapLabel(seconds)}
      </strong>
    </div>
  );
}
