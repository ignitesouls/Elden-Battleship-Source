import { useEffect, useState } from "react";
import {
  fetchFairnessGaps,
  fairnessOf,
  fairnessBand,
  gapLabel,
  ordinal,
  type MatchBalance,
} from "../lib/matchBalance";
import { teamHex, teamName } from "../lib/teamColors";

/**
 * How fair the board was, on the recap.
 *
 * Every team fires at the SAME named grid, so which squares sit on which fleet's cells is the entire
 * competitive asymmetry of a match - and until the balancer landed, that was decided by a shuffle
 * struck before anyone had placed a ship. This is the one place a player gets told what that came
 * out as. It reads the number the balancer recorded at the moment it dealt the board; nothing is
 * computed here and no square is ever priced in a browser.
 *
 * -- Three numbers and two lines ------------------------------------------------------------------
 *
 * The percentile and the two gaps, under a single line naming what the percentile is a rank against:
 * a bare ordinal reads as a score on this match rather than a place among every board ever dealt.
 * Not the size of that field, though. One more line sits under the bars saying what a gap IS,
 * which direction is good, and - once the record carries it - which fleet the gap was in favour of,
 * because two durations with no unit named read as match times. A second such line names the FIND
 * gap, which is the same comparison off the other end of every ship and frequently favours the
 * other side; it stays a line rather than becoming a second chart. It once
 * carried paragraphs explaining what a square's cost is, how the ranks are matched up, and what the
 * shuffle bought, and read like a lecture nobody asked for. A caster can say any of that on air in
 * a sentence; the recap does not need to say it every time.
 *
 * -- Naming the fleet that was ahead ---------------------------------------------------------------
 *
 * The gap is a spread, so for a long time this panel could not say whose edge it was: the number
 * measured how wide, never which side. The balancer knew - it finds the worst rank and takes the
 * difference between the cheapest and dearest ship there - and dropped the answer a line later.
 * It records `aheadTeam` now, and the sweep writes it onto older records that have a gap and no
 * side. Anything older still than THAT falls back to the unnamed sentence rather than guessing, and
 * `topCost` remains no help: its order comes from a fleet query, not from the team numbers.
 */
export function BalanceReadout({
  balance,
  width = "min(560px, 100%)",
}: {
  balance: MatchBalance | null;
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
  // False only on a swept record for a room the balancer never touched. A deal-time record exists
  // BECAUSE the balancer ran, so an absent flag means it ran.
  const unbalanced = balance.hadPerm === false;

  /**
   * The fleet the gap was in favour of, when the record knows.
   *
   * Three states, and they are not the same: a number is a named side, null is a board measured
   * dead even, and absent is a record written before any of this was kept. Only the first names a
   * fleet - the other two fall back to the sentence that describes the gap without taking a side,
   * because "nobody was ahead" and "nobody wrote down who was ahead" both come out as no name.
   */
  const ahead = typeof balance.aheadTeam === "number" ? balance.aheadTeam : null;

  /**
   * The other half of the board, when the record carries it: how far apart the fleets were on being
   * FOUND rather than on being finished off.
   *
   * One line rather than a second pair of bars, and that restraint is the point. It is a different
   * measurement off the other end of every ship, not a stage of the same one, so putting it in the
   * before/after bars would read as a third column of the same story. A caster can make more of it
   * in a sentence than a chart can.
   *
   * Absent on every record dealt before the find test shipped, which is most of the archive - so it
   * simply does not render, the same way the direction did not before the sweep filled it in.
   */
  const findGap = typeof balance.findPlayed === "number" ? balance.findPlayed : null;
  const hidden = typeof balance.findAheadTeam === "number" ? balance.findAheadTeam : null;

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

      {fairness ? (
        <div className="stack" style={{ gap: "0.1rem" }}>
          <span style={{ fontSize: "1.7rem", fontWeight: 700, lineHeight: 1.1, color: "var(--accent)" }}>
            {ordinal(fairness.percentile)} percentile
          </span>
          <span className="muted" style={{ fontSize: "0.72rem" }}>
            in terms of fairness, compared to every match played
          </span>
        </div>
      ) : (
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          {gaps === null ? "Ranking this board..." : "Nothing to rank this against yet."}
        </span>
      )}

      <div className="stack" style={{ gap: "0.3rem", marginTop: "0.1rem" }}>
        <GapBar label="Before shuffling" seconds={balance.dealt} scale={scale} tone="var(--text-dim)" />
        <GapBar
          label={unbalanced ? "Never shuffled" : "As played"}
          seconds={balance.played}
          scale={scale}
          tone={band.color}
        />
        <span className="muted" style={{ fontSize: "0.7rem", marginTop: "0.1rem" }}>
          {ahead === null ? (
            "The head start the luckiest fleet held. Lower is fairer."
          ) : (
            <>
              The head start{" "}
              <strong style={{ color: teamHex(ahead) }}>{teamName(ahead)}</strong> held. Lower is
              fairer.
            </>
          )}
        </span>
        {findGap !== null && (
          <span className="muted" style={{ fontSize: "0.7rem" }}>
            {hidden === null ? (
              <>One fleet stayed hidden {gapLabel(findGap)} longer before its ships were found.</>
            ) : (
              <>
                <strong style={{ color: teamHex(hidden) }}>{teamName(hidden)}</strong> stayed hidden{" "}
                {gapLabel(findGap)} longer before their ships were found.
              </>
            )}
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
