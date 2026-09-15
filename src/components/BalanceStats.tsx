import { useState } from "react";
import {
  sweepBalanceStats,
  mmss,
  pct,
  type BalanceStats as Stats,
  type GapSet,
  type SweepProgress,
  type Summary,
  SLICE,
} from "../lib/balanceStats";
import { useT } from "../lib/language";

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
  const t = useT();
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

  const run = async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    setPersisted(null);
    const res = await sweepBalanceStats(setProgress);
    setBusy(false);
    setProgress(null);
    if (res.ok) {
      setStats(res.stats);
      setPersisted(res.persisted);
    } else setError(reasonText(res.reason, t));
  };

  return (
    <div className="panel stack" style={{ gap: "0.7rem", width: "100%" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: "1rem" }}>{t("Board balance", "Équilibre du plateau")}</h2>
        <button onClick={() => void run()} disabled={busy}>
          {busy
            ? t("Scoring...", "Analyse en cours...")
            : stats
              ? t("Re-run", "Relancer")
              : t("Score the archive", "Analyser les archives")}
        </button>
      </div>

      <p className="muted" style={{ margin: 0, fontSize: "0.76rem" }}>
        {t(
          "Every archived match re-scored against the current model. A ship costs its slowest square, a fleet is its ships sorted longest first, and the gap is the widest difference between two fleets at the same rank. Lower is fairer.",
          "Chaque partie archivée est réévaluée avec le modèle actuel. Un navire coûte sa case la plus lente, une flotte est ses navires triés du plus long au plus court, et l'écart est la plus grande différence entre deux flottes au même rang. Plus c'est bas, plus c'est équitable."
        )}
      </p>

      {error && (
        <div className="muted" style={{ fontSize: "0.78rem", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {busy && (
        <span className="muted" style={{ fontSize: "0.78rem" }}>
          {progress
            ? `${t("Scored", "Analysé")} ${progress.done} ${t("of", "sur")} ${progress.total} ${t("matches", "parties")}` +
              // Only said once it has actually narrowed, which is against the slice the walk STARTED
              // on rather than a literal. That literal was 3, and outlived the SLICE it was copied
              // from - once SLICE dropped to 1 the condition was true on every clean sweep, so a run
              // that never hit a 546 still reported having been narrowed.
              (progress.slice < SLICE
                ? ` ${t("- narrowed to", "- réduit à")} ${progress.slice} ${t("per request", "par requête")}`
                : "")
            : t("Listing the archive...", "Liste de l'archive en cours...")}
        </span>
      )}

      {persisted !== null && !busy && (
        <span className="muted" style={{ fontSize: "0.76rem" }}>
          {persisted === 0
            ? t(
                "Every scored match already had a fairness record on its recap.",
                "Chaque partie analysée avait déjà une mention d'équité sur son récapitulatif."
              )
            : `${t("Backfilled", "Complété pour")} ${persisted} ${persisted === 1 ? t("recap", "récapitulatif") : t("recaps", "récapitulatifs")} ${t("that had no fairness record.", "qui n'avaient aucune mention d'équité.")}`}
        </span>
      )}

      {stats && <Report stats={stats} />}
    </div>
  );
}

function reasonText(reason: string, t: (en: string, fr: string) => string): string {
  if (reason.includes("not_admin"))
    return `${t("The server refused - this account is not an administrator.", "Le serveur a refusé - ce compte n'est pas administrateur.")} (${reason})`;
  if (reason.includes("not_signed_in"))
    return `${t("The server refused - no signed-in session on the request.", "Le serveur a refusé - aucune session connectée sur la requête.")} (${reason})`;
  if (reason === "timed out")
    return t("The sweep ran past two minutes and gave up.", "L'analyse a dépassé deux minutes et a abandonné.");
  // 546 is the platform killing a worker that ran past its CPU budget, which is a different problem
  // from anything this function decided, so it is named rather than left as a bare number.
  if (reason.startsWith("HTTP 546") || reason.toLowerCase().includes("cpu")) {
    return `${t("The worker ran out of CPU budget. The sweep is too big for one request.", "Le worker a épuisé son budget CPU. L'analyse est trop volumineuse pour une seule requête.")} (${reason})`;
  }
  return `${t("Could not score the archive:", "Impossible d'analyser les archives :")} ${reason}`;
}

function Report({ stats }: { stats: Stats }) {
  const t = useT();
  const { counts, overall, balancerOfTheDay, stranded } = stats;
  const limit = stats.rankLimitSeconds;
  // Its own line, not the rank one. See FIND_GAP_SECONDS for why the two differ by a factor of two.
  const findLimit = stats.findLimitSeconds;
  const rejectedTotal = Object.values(counts.rejected).reduce((a, b) => a + b, 0);

  return (
    <div className="stack" style={{ gap: "0.8rem" }}>
      <span className="muted" style={{ fontSize: "0.72rem" }}>
        {counts.scored} {t("of", "sur")} {counts.matchesInArchive} {t("matches scored", "parties analysées")}
        {rejectedTotal > 0 && ` - ${rejectedTotal} ${t("skipped", "ignorées")}`}
        {stats.duration && ` - ${t("median match", "partie médiane")} ${mmss(stats.duration.median)}`}
        {" - "}
        {t("thresholds", "seuils")}{" "}
        {mmss(limit)} {t("rank", "rang")} / {mmss(findLimit)} {t("find", "découverte")}
      </span>

      {/* The headline: same deal, three balancers. */}
      <Section
        title={t("Fairness gap", "Écart d'équité")}
        note={t(
          "The same boards, three ways. Dealt is the raw seeded deal. Played is what the match ran on. Rebalanced is what today's balancer would make of that same deal.",
          "Les mêmes plateaux, de trois façons. Distribué est le tirage brut d'origine. Joué est ce sur quoi la partie s'est déroulée. Rééquilibré est ce que l'équilibreur actuel ferait du même tirage."
        )}
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>&nbsp;</Th>
              <Th right>{t("Mean", "Moyenne")}</Th>
              <Th right>{t("Median", "Médiane")}</Th>
              <Th right>p90</Th>
              <Th right>{t("Worst", "Pire")}</Th>
              <Th right>{t("Over", "Plus de")} {mmss(limit)}</Th>
            </tr>
          </thead>
          <tbody>
            <Row label={t("Dealt", "Distribué")} s={overall.dealt} />
            <Row label={t("Played", "Joué")} s={overall.played} />
            <Row label={t("Rebalanced", "Rééquilibré")} s={overall.rebalanced} strong />
          </tbody>
        </table>
      </Section>

      {/*
        The other end of every ship. Its own table rather than three more rows in the one above,
        because it is measured against its own threshold - ten minutes, not five - and stacking two
        different limits under one "Over 5:00" column would silently misreport both.
      */}
      <Section
        title={t("Find gap", "Écart de découverte")}
        note={t(
          "The same boards on when ships get FOUND rather than on when they get cleared - a hull is found through its cheapest square and cleared at its dearest. Over the archive the two ends of a ship correlate at r = 0.19, so this is not the table above said twice.",
          "Les mêmes plateaux, mais sur le moment où les navires sont TROUVÉS plutôt que sur celui où ils sont éliminés - une coque est trouvée par sa case la moins chère et éliminée par sa plus chère. Sur l'ensemble des archives, les deux bouts d'un navire ne corrèlent qu'à r = 0.19, donc ceci n'est pas le tableau du haut redit deux fois."
        )}
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>&nbsp;</Th>
              <Th right>{t("Mean", "Moyenne")}</Th>
              <Th right>{t("Median", "Médiane")}</Th>
              <Th right>p90</Th>
              <Th right>{t("Worst", "Pire")}</Th>
              <Th right>{t("Over", "Plus de")} {mmss(findLimit)}</Th>
            </tr>
          </thead>
          <tbody>
            <Row label={t("Dealt", "Distribué")} s={stats.overallFind.dealt} />
            <Row label={t("Played", "Joué")} s={stats.overallFind.played} />
            <Row label={t("Rebalanced", "Rééquilibré")} s={stats.overallFind.rebalanced} strong />
          </tbody>
        </table>
      </Section>

      {/* The test the old model failed. */}
      <Section
        title={t("Did the balancer of the day do anything?", "L'équilibreur du jour a-t-il fait quelque chose ?")}
        note={t(
          "Matches split by whether the balancer actually ran. If these two rows look the same, it did nothing. That is what the old per-cell model looked like.",
          "Parties séparées selon que l'équilibreur ait vraiment tourné ou non. Si ces deux lignes se ressemblent, il n'a rien fait. C'est à cela que ressemblait l'ancien modèle par case."
        )}
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>&nbsp;</Th>
              <Th right>{t("Matches", "Parties")}</Th>
              <Th right>{t("Mean", "Moyenne")}</Th>
              <Th right>{t("Median", "Médiane")}</Th>
              <Th right>{t("Over", "Plus de")} {mmss(limit)}</Th>
            </tr>
          </thead>
          <tbody>
            <SplitRow label={t("Balancer ran", "Équilibreur exécuté")} bucket={balancerOfTheDay.balanced} />
            <SplitRow label={t("Never balanced", "Jamais équilibré")} bucket={balancerOfTheDay.unbalanced} />
          </tbody>
        </table>
      </Section>

      <Section
        title={t("Stranded fleets", "Flottes échouées")}
        note={t(
          "A fleet is stranded when one of its ships sits on a square that takes longer to beat than the match lasted. One side stranded and the other not is what makes a match unwinnable rather than merely long.",
          "Une flotte est échouée quand un de ses navires occupe une case plus longue à vaincre que la partie n'a duré. Un camp échoué et l'autre non, voilà ce qui rend une partie ingagnable plutôt que simplement longue."
        )}
      >
        <table style={tableStyle}>
          <tbody>
            <tr>
              <Td>{t("Neither side stranded", "Aucun camp échoué")}</Td>
              <Td right>{stranded.none}</Td>
              <Td right muted>
                {share(stranded.none, counts.scored)}
              </Td>
            </tr>
            <tr>
              <Td>
                <strong>{t("One side only", "Un seul camp")}</strong>
              </Td>
              <Td right>
                <strong>{stranded.oneSided}</strong>
              </Td>
              <Td right muted>
                {share(stranded.oneSided, counts.scored)}
              </Td>
            </tr>
            <tr>
              <Td>{t("Both sides", "Les deux camps")}</Td>
              <Td right>{stranded.both}</Td>
              <Td right muted>
                {share(stranded.both, counts.scored)}
              </Td>
            </tr>
          </tbody>
        </table>
      </Section>

      <Breakdown title={t("By board size", "Par taille du plateau")} groups={stats.byBoardSize} suffix="" limit={limit} />
      <Breakdown
        title={t("By team count", "Par nombre d'équipes")}
        groups={stats.byTeamCount}
        suffix={` ${t("teams", "équipes")}`}
        limit={limit}
      />
      <Breakdown title={t("By square set", "Par jeu de cases")} groups={stats.bySquareSet} suffix="" limit={limit} />

      <Section
        title={t("Worst boards played", "Pires plateaux joués")}
        note={t("Sorted by the gap the match actually ran on.", "Triés par l'écart réel de la partie jouée.")}
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>{t("Match", "Partie")}</Th>
              <Th right>{t("Size", "Taille")}</Th>
              <Th right>{t("Teams", "Équipes")}</Th>
              <Th right>{t("Length", "Durée")}</Th>
              <Th right>{t("Played", "Joué")}</Th>
              <Th right>{t("Rebalanced", "Rééquilibré")}</Th>
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
        <Section
          title={t("Skipped", "Ignorées")}
          note={t("Matches the sweep would not score, and why.", "Parties que l'analyse n'a pas notées, et pourquoi.")}
        >
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
  const t = useT();
  const keys = Object.keys(groups).sort();
  if (keys.length < 2) return null; // one bucket is the overall table again
  return (
    <Section title={title} note="">
      <table style={tableStyle}>
        <thead>
          <tr>
            <Th>&nbsp;</Th>
            <Th right>{t("Matches", "Parties")}</Th>
            <Th right>{t("Played", "Joué")}</Th>
            <Th right>{t("Rebalanced", "Rééquilibré")}</Th>
            <Th right>{t("Over", "Plus de")} {mmss(limit)}</Th>
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
