import { useState } from "react";
import {
  sweepBalanceStats,
  mmss,
  pct,
  type BalanceStats as Stats,
  type GapSet,
  type SweepProgress,
  type Summary,
} from "../lib/balanceStats";

/**
 * The balance model, scored against every match on record.
 *
 * Replaces the old BalanceExplainer, which was deleted for two reasons: it measured the retired
 * per-cell metric, and it imported the cost table straight into this chunk. The second is the one
 * worth remembering - `Admin-<hash>.js` is a static file on Pages, fetchable by anyone without
 * signing in, because the admin check runs in the browser after the chunk has already downloaded.
 * So the numbers here are computed server-side and arrive as summaries; nothing in this file knows
 * what any square costs.
 *
 * Behind a button rather than loaded with the page: the sweep re-derives every board in the archive
 * and re-runs the balancer on each, which is real work and nobody wants it on every visit.
 */
export function BalanceStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SweepProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Archived matches that gained a fairness record from this run.
   *
   * The sweep is the only way a match finished before the balancer kept its own record can ever get
   * one, so what it wrote down is worth reporting rather than leaving as a silent side effect. It
   * fills gaps only and never overwrites, so a second run normally reports zero - which is the
   * backfill being complete, not the write having failed.
   */
  const [persisted, setPersisted] = useState<number | null>(null);
  /**
   * Records that already had a fairness number and gained only the side it was in favour of.
   *
   * Counted apart from the backfill above because it is a different write with a different rule:
   * the backfill refuses to touch an existing record, and this one deliberately adds a single field
   * to records the backfill is barred from. Reported separately so a run that filled no gaps but
   * named forty sides does not read as having done nothing.
   */
  const [directed, setDirected] = useState<number | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    setPersisted(null);
    setDirected(null);
    const res = await sweepBalanceStats(setProgress);
    setBusy(false);
    setProgress(null);
    if (res.ok) {
      setStats(res.stats);
      setPersisted(res.persisted);
      setDirected(res.directed);
    } else setError(reasonText(res.reason));
  };

  return (
    <div className="panel stack" style={{ gap: "0.7rem", width: "100%" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: "1rem" }}>Board balance</h2>
        <button onClick={() => void run()} disabled={busy}>
          {busy ? "Scoring..." : stats ? "Re-run" : "Score the archive"}
        </button>
      </div>

      <p className="muted" style={{ margin: 0, fontSize: "0.76rem" }}>
        Every archived match re-scored against the current model. A ship costs its slowest square, a
        fleet is its ships sorted longest first, and the gap is the widest difference between two
        fleets at the same rank. Lower is fairer.
      </p>

      {error && (
        <div className="muted" style={{ fontSize: "0.78rem", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {busy && (
        <span className="muted" style={{ fontSize: "0.78rem" }}>
          {progress
            ? `Scored ${progress.done} of ${progress.total} matches` +
              // Only said once it has had to narrow - see the 546 handling in the sweep.
              (progress.slice < 3 ? ` - narrowed to ${progress.slice} per request` : "")
            : "Listing the archive..."}
        </span>
      )}

      {persisted !== null && !busy && (
        <span className="muted" style={{ fontSize: "0.76rem" }}>
          {persisted === 0
            ? "Every scored match already had a fairness record on its recap."
            : `Backfilled ${persisted} ${persisted === 1 ? "recap" : "recaps"} that had no fairness record.`}
        </span>
      )}

      {directed !== null && directed > 0 && !busy && (
        <span className="muted" style={{ fontSize: "0.76rem" }}>
          {`Named which team was ahead on ${directed} ${directed === 1 ? "recap" : "recaps"} that had a fairness record without one.`}
        </span>
      )}

      {stats && <Report stats={stats} />}
    </div>
  );
}

function reasonText(reason: string): string {
  if (reason.includes("not_admin")) return `The server refused - this account is not an administrator. (${reason})`;
  if (reason.includes("not_signed_in")) return `The server refused - no signed-in session on the request. (${reason})`;
  if (reason === "timed out") return "The sweep ran past two minutes and gave up.";
  // 546 is the platform killing a worker that ran past its CPU budget, which is a different problem
  // from anything this function decided, so it is named rather than left as a bare number.
  if (reason.startsWith("HTTP 546") || reason.toLowerCase().includes("cpu")) {
    return `The worker ran out of CPU budget. The sweep is too big for one request. (${reason})`;
  }
  return `Could not score the archive: ${reason}`;
}

function Report({ stats }: { stats: Stats }) {
  const { counts, overall, balancerOfTheDay, stranded } = stats;
  const limit = stats.rankLimitSeconds;
  const rejectedTotal = Object.values(counts.rejected).reduce((a, b) => a + b, 0);

  return (
    <div className="stack" style={{ gap: "0.8rem" }}>
      <span className="muted" style={{ fontSize: "0.72rem" }}>
        {counts.scored} of {counts.matchesInArchive} matches scored
        {rejectedTotal > 0 && ` - ${rejectedTotal} skipped`}
        {stats.duration && ` - median match ${mmss(stats.duration.median)}`}
        {" - threshold "}
        {mmss(limit)}
      </span>

      {/* The headline: same deal, three balancers. */}
      <Section
        title="Fairness gap"
        note="The same boards, three ways. Dealt is the raw seeded deal. Played is what the match ran on. Rebalanced is what today's balancer would make of that same deal."
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>&nbsp;</Th>
              <Th right>Mean</Th>
              <Th right>Median</Th>
              <Th right>p90</Th>
              <Th right>Worst</Th>
              <Th right>Over {mmss(limit)}</Th>
            </tr>
          </thead>
          <tbody>
            <Row label="Dealt" s={overall.dealt} />
            <Row label="Played" s={overall.played} />
            <Row label="Rebalanced" s={overall.rebalanced} strong />
          </tbody>
        </table>
      </Section>

      {/* The test the old model failed. */}
      <Section
        title="Did the balancer of the day do anything?"
        note="Matches split by whether the balancer actually ran. If these two rows look the same, it did nothing. That is what the old per-cell model looked like."
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>&nbsp;</Th>
              <Th right>Matches</Th>
              <Th right>Mean</Th>
              <Th right>Median</Th>
              <Th right>Over {mmss(limit)}</Th>
            </tr>
          </thead>
          <tbody>
            <SplitRow label="Balancer ran" bucket={balancerOfTheDay.balanced} />
            <SplitRow label="Never balanced" bucket={balancerOfTheDay.unbalanced} />
          </tbody>
        </table>
      </Section>

      <Section
        title="Stranded fleets"
        note="A fleet is stranded when one of its ships sits on a square that takes longer to beat than the match lasted. One side stranded and the other not is what makes a match unwinnable rather than merely long."
      >
        <table style={tableStyle}>
          <tbody>
            <tr>
              <Td>Neither side stranded</Td>
              <Td right>{stranded.none}</Td>
              <Td right muted>
                {share(stranded.none, counts.scored)}
              </Td>
            </tr>
            <tr>
              <Td>
                <strong>One side only</strong>
              </Td>
              <Td right>
                <strong>{stranded.oneSided}</strong>
              </Td>
              <Td right muted>
                {share(stranded.oneSided, counts.scored)}
              </Td>
            </tr>
            <tr>
              <Td>Both sides</Td>
              <Td right>{stranded.both}</Td>
              <Td right muted>
                {share(stranded.both, counts.scored)}
              </Td>
            </tr>
          </tbody>
        </table>
      </Section>

      <Breakdown title="By board size" groups={stats.byBoardSize} suffix="" limit={limit} />
      <Breakdown title="By team count" groups={stats.byTeamCount} suffix=" teams" limit={limit} />
      <Breakdown title="By square set" groups={stats.bySquareSet} suffix="" limit={limit} />

      <Section title="Worst boards played" note="Sorted by the gap the match actually ran on.">
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>Match</Th>
              <Th right>Size</Th>
              <Th right>Teams</Th>
              <Th right>Length</Th>
              <Th right>Played</Th>
              <Th right>Rebalanced</Th>
            </tr>
          </thead>
          <tbody>
            {stats.worstPlayed.map((m) => (
              <tr key={m.matchKey}>
                <Td>{m.matchKey}</Td>
                <Td right>
                  {m.boardSize}x{m.boardSize}
                </Td>
                <Td right>{m.teams}</Td>
                <Td right>{mmss(m.durationSec)}</Td>
                <Td right>{mmss(m.played)}</Td>
                <Td right muted={m.rebalanced <= m.played}>{mmss(m.rebalanced)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {rejectedTotal > 0 && (
        <Section title="Skipped" note="Matches the sweep would not score, and why.">
          <div className="stack" style={{ gap: "0.15rem" }}>
            {Object.entries(counts.rejected)
              .sort((a, b) => b[1] - a[1])
              .map(([why, n]) => (
                <span key={why} className="muted" style={{ fontSize: "0.74rem" }}>
                  {n} - {why.replace(/_/g, " ")}
                </span>
              ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Breakdown({
  title,
  groups,
  suffix,
  limit,
}: {
  title: string;
  groups: Record<string, GapSet>;
  suffix: string;
  limit: number;
}) {
  const keys = Object.keys(groups).sort();
  if (keys.length < 2) return null; // one bucket is the overall table again
  return (
    <Section title={title} note="">
      <table style={tableStyle}>
        <thead>
          <tr>
            <Th>&nbsp;</Th>
            <Th right>Matches</Th>
            <Th right>Played</Th>
            <Th right>Rebalanced</Th>
            <Th right>Over {mmss(limit)}</Th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <Td>
                {k}
                {suffix}
              </Td>
              <Td right>{groups[k].matches}</Td>
              <Td right>{groups[k].played ? mmss(groups[k].played.median) : "-"}</Td>
              <Td right>{groups[k].rebalanced ? mmss(groups[k].rebalanced.median) : "-"}</Td>
              <Td right muted>
                {groups[k].rebalanced ? pct(groups[k].rebalanced.overLimit) : "-"}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

const share = (n: number, of: number) => (of > 0 ? pct(n / of) : "-");

function Row({ label, s, strong }: { label: string; s: Summary | null; strong?: boolean }) {
  if (!s) return null;
  const Cell = strong ? "strong" : "span";
  return (
    <tr>
      <Td>
        <Cell>{label}</Cell>
      </Td>
      <Td right>{mmss(s.mean)}</Td>
      <Td right>{mmss(s.median)}</Td>
      <Td right>{mmss(s.p90)}</Td>
      <Td right>{mmss(s.max)}</Td>
      <Td right>{pct(s.overLimit)}</Td>
    </tr>
  );
}

function SplitRow({ label, bucket }: { label: string; bucket: { matches: number; played: Summary | null } }) {
  return (
    <tr>
      <Td>{label}</Td>
      <Td right>{bucket.matches}</Td>
      <Td right>{bucket.played ? mmss(bucket.played.mean) : "-"}</Td>
      <Td right>{bucket.played ? mmss(bucket.played.median) : "-"}</Td>
      <Td right>{bucket.played ? pct(bucket.played.overLimit) : "-"}</Td>
    </tr>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div
      className="stack"
      style={{ gap: "0.3rem", borderTop: "1px solid var(--panel-border)", paddingTop: "0.6rem" }}
    >
      <strong style={{ fontSize: "0.82rem" }}>{title}</strong>
      {note && (
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          {note}
        </span>
      )}
      <div style={{ overflowX: "auto" }}>{children}</div>
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  fontSize: "0.78rem",
  fontVariantNumeric: "tabular-nums",
  minWidth: "100%",
};

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className="muted"
      style={{
        textAlign: right ? "right" : "left",
        fontWeight: 500,
        fontSize: "0.72rem",
        padding: "0.15rem 0.5rem 0.15rem 0",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  muted,
}: {
  children: React.ReactNode;
  right?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={muted ? "muted" : undefined}
      style={{
        textAlign: right ? "right" : "left",
        padding: "0.15rem 0.5rem 0.15rem 0",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}
