import { useEffect, useState } from "react";
import { fetchFairnessGaps, fairnessOf, ordinal, type MatchBalance } from "../lib/matchBalance";
import { useT } from "../lib/language";

/**
 * How fair the board was, on the recap.
 *
 * Every team fires at the SAME named grid, so which squares sit on which fleet's cells is the entire
 * competitive asymmetry of a match - and until the balancer landed, that was decided by a shuffle
 * struck before anyone had placed a ship. This is the one place a player gets told what that came
 * out as. It reads the number the balancer recorded at the moment it dealt the board; nothing is
 * computed here and no square is ever priced in a browser.
 *
 * -- One number ------------------------------------------------------------------------------------
 *
 * A percentile and the line saying what it is a rank against. That is the whole panel.
 *
 * It used to carry two bars - the gap before shuffling and after - a band chip reading "Even" or
 * "Slight edge", a line naming the fleet that came out ahead, and a second line for the find gap.
 * Five elements, of which THREE were the same number: the played gap drawn as a bar, banded into a
 * word, and ranked into a percentile. One fact wearing three hats reads as noise, and the bars were
 * the worst of it - two bare durations with no unit named, which a reader takes for match times.
 *
 * What the cut is really about: none of those numbers is a duration anybody experienced. A rank gap
 * is the widest same-rank spread between two sorted profiles, so "3:30" is not three and a half
 * minutes of anything that happened - it is a distance between two orderings. Printing it beside a
 * clock invites exactly the wrong reading, and no amount of caption fixes that. A percentile makes
 * no such promise: it says where this board sits among every board, which is a claim a rank actually
 * supports.
 *
 * So the panel says the one thing it can say honestly and stops. A caster who wants the detail has
 * the whole record - both gaps, both directions, the long-square count - in the balance report, and
 * can say it on air in a sentence.
 *
 * -- What the percentile ranks ---------------------------------------------------------------------
 *
 * `played`, the rank gap: how far apart the two fleets were on when their ships get CLEARED. NOT the
 * find gap and not the long-square count, because those are not in the column this ranks against -
 * see fetchFairnessGaps, which reads one field off every archived record.
 *
 * Worth knowing while reading the word "fairness" above it, since the balancer now holds boards to
 * three tests and this ranks on one of them. Widening it means backfilling the other two across the
 * whole archive first, or the denominator is a mix of boards scored different ways - which would be
 * a worse number than a narrow one.
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
   * already read.
   */
  const [gaps, setGaps] = useState<number[] | null>(null);
  const t = useT();

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

  return (
    <div className="panel stack" style={{ gap: "0.45rem", width }}>
      <h3 style={{ margin: 0 }}>{t("Board fairness", "Équité du plateau")}</h3>

      {fairness ? (
        <div className="stack" style={{ gap: "0.1rem" }}>
          <span style={{ fontSize: "1.7rem", fontWeight: 700, lineHeight: 1.1, color: "var(--accent)" }}>
            {ordinal(fairness.percentile)} {t("percentile", "centile")}
          </span>
          <span className="muted" style={{ fontSize: "0.72rem" }}>
            {t("in terms of fairness, compared to every match played", "en termes d'équité, par rapport à toutes les parties jouées")}
          </span>
        </div>
      ) : (
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          {gaps === null
            ? t("Ranking this board...", "Classement de ce plateau en cours...")
            : t("Nothing to rank this against yet.", "Rien à comparer pour l'instant.")}
        </span>
      )}
    </div>
  );
}
