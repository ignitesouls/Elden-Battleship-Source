import { useState } from "react";
import { Link } from "react-router-dom";
import { profileName, type Profile } from "../lib/profiles";
import {
  METRICS,
  matchesUntilRated,
  MIN_FIELD_SIZE,
  MIN_MATCHES_FOR_TRAITS,
  type MetricDef,
  type MetricReading,
  type ScoutingReport,
} from "../lib/scouting";
import { useT } from "../lib/language";

interface Props {
  reports: ScoutingReport[];
  profiles: Map<string, Profile>;
  /** Square set these reports were built from, passed through to the career pages. */
  setId: string;
}

/**
 * The captains, one card each.
 *
 * A card only ever shows what its sample supports: counting stats always, and the comparative
 * layer - traits, ranks, "vs field" - only once the player and the field have cleared the
 * thresholds in scouting.ts. An unrated card says how many matches are still needed instead of
 * dressing two games up as a scouting read.
 */
export function CaptainCards({ reports, profiles, setId }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState<string | null>(null);
  const rated = reports.filter((r) => r.rated).length;

  if (reports.length === 0) {
    return (
      <div className="panel">
        <p className="muted" style={{ margin: 0 }}>
          {t("No captains on this board yet.", "Pas encore de capitaines sur ce plateau.")}
        </p>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: "0.6rem" }}>
      <div className="panel stack" style={{ gap: "0.2rem" }}>
        <h3 style={{ margin: 0 }}>{t("Captains", "Capitaines")}</h3>
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          {t(
            `${reports.length} on record, ${rated} with enough matches to rank.`,
            `${reports.length} enregistrés, ${rated} avec assez de parties pour être classés.`
          )}
          {rated < MIN_FIELD_SIZE &&
            t(
              ` Ranking needs ${MIN_MATCHES_FOR_TRAITS} matches each, from ${MIN_FIELD_SIZE} captains. These are plain totals until then.`,
              ` Le classement nécessite ${MIN_MATCHES_FOR_TRAITS} parties chacun, à partir de ${MIN_FIELD_SIZE} capitaines. Ce ne sont que des totaux bruts jusque-là.`
            )}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(15rem, 1fr))",
          gap: "0.6rem",
          alignItems: "start",
        }}
      >
        {reports.map((r) => (
          <Card
            key={r.key}
            report={r}
            profile={r.userId ? profiles.get(r.userId) : undefined}
            setId={setId}
            open={expanded === r.key}
            onToggle={() => setExpanded((k) => (k === r.key ? null : r.key))}
          />
        ))}
      </div>
    </div>
  );
}

function Card({
  report,
  profile,
  setId,
  open,
  onToggle,
}: {
  report: ScoutingReport;
  profile: Profile | undefined;
  setId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const name = profileName(profile) ?? report.nickname;
  const waiting = matchesUntilRated(report);

  return (
    <div className="panel stack" style={{ gap: "0.4rem", minWidth: 0 }}>
      <div className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
        {profile?.avatar_url ? (
          <img
            src={profile.avatar_url}
            alt=""
            width={40}
            height={40}
            style={{ borderRadius: "50%", border: "2px solid var(--accent)", flexShrink: 0 }}
          />
        ) : (
          <div
            aria-hidden
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              flexShrink: 0,
              border: "2px solid var(--panel-border)",
              display: "grid",
              placeItems: "center",
              fontSize: "1rem",
            }}
          >
            ⚓
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Link
            to={`/player/${encodeURIComponent(report.key)}?set=${encodeURIComponent(setId)}`}
            style={{ fontWeight: 700, fontSize: "0.95rem" }}
          >
            {name}
          </Link>
          <div className="muted" style={{ fontSize: "0.7rem", fontVariantNumeric: "tabular-nums" }}>
            {report.wins}-{report.losses}
            {report.draws > 0 ? `-${report.draws}` : ""} · {report.matches}{" "}
            {report.matches === 1 ? t("match", "partie") : t("matches", "parties")}
            {!report.verified && t(" · guest", " · invité")}
          </div>
        </div>
        <ConfidenceChip report={report} />
      </div>

      <span className="muted" style={{ fontSize: "0.72rem" }}>
        {report.summary}
      </span>

      {report.traits.length > 0 && (
        <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
          {report.traits.map((t) => (
            <span
              key={t.name}
              title={t.blurb}
              className="display"
              style={{
                fontSize: "0.64rem",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                padding: "0.15rem 0.4rem",
                borderRadius: 3,
                border: "1px solid var(--accent)",
                color: "var(--accent)",
              }}
            >
              {t.name}
            </span>
          ))}
        </div>
      )}

      {waiting > 0 && (
        <span className="muted" style={{ fontSize: "0.68rem" }}>
          {t(
            `${waiting} more ${waiting === 1 ? "match" : "matches"} before this card can be read.`,
            `${waiting} ${waiting === 1 ? "partie" : "parties"} de plus avant que cette fiche puisse être lue.`
          )}
        </span>
      )}

      {/* Two headline numbers even when unrated - these are counts, not claims about tendency. */}
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
        <Headline report={report} id="accuracy" />
        <Headline report={report} id="shotsPerMatch" />
        <Headline report={report} id="sinkConversion" />
      </div>

      {(report.favoriteSquare || report.favoriteOpener) && (
        <div className="muted" style={{ fontSize: "0.7rem" }}>
          {report.favoriteSquare && (
            <div>
              {t("Favorite square:", "Case préférée :")}{" "}
              <strong style={{ color: "var(--text)" }}>{report.favoriteSquare.name}</strong>{" "}
              ({report.favoriteSquare.count}×)
            </div>
          )}
          {report.favoriteOpener && (
            <div>
              {t("Opens with:", "Ouvre avec :")}{" "}
              <strong style={{ color: "var(--text)" }}>{report.favoriteOpener.name}</strong>{" "}
              ({report.favoriteOpener.count}×)
            </div>
          )}
        </div>
      )}

      <button
        onClick={onToggle}
        style={{ alignSelf: "flex-start", fontSize: "0.7rem", padding: "0.15rem 0.45rem" }}
        aria-expanded={open}
      >
        {open ? t("Less", "Réduire") : t("Full read", "Fiche complète")}
      </button>

      {open && <FullRead report={report} />}
    </div>
  );
}

const CONFIDENCE_LABEL: Record<ScoutingReport["confidence"], [string, string]> = {
  unrated: ["Unrated", "Non classé"],
  low: ["Low confidence", "Confiance faible"],
  medium: ["Medium confidence", "Confiance moyenne"],
  high: ["High confidence", "Confiance élevée"],
};

function ConfidenceChip({ report }: { report: ScoutingReport }) {
  const t = useT();
  const label = t(...CONFIDENCE_LABEL[report.confidence]);
  const dim = report.confidence === "unrated" || report.confidence === "low";
  return (
    <span
      title={t(
        `Based on ${report.matches} ${report.matches === 1 ? "match" : "matches"}`,
        `Basé sur ${report.matches} ${report.matches === 1 ? "partie" : "parties"}`
      )}
      style={{
        fontSize: "0.6rem",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        padding: "0.1rem 0.35rem",
        borderRadius: 3,
        border: `1px solid ${dim ? "var(--panel-border)" : "var(--accent)"}`,
        color: dim ? "var(--text-dim)" : "var(--accent)",
      }}
    >
      {label}
    </span>
  );
}

/** Every metric, with the field comparison when there is one to make. */
function FullRead({ report }: { report: ScoutingReport }) {
  const t = useT();
  return (
    <div className="stack" style={{ gap: "0.35rem", borderTop: "1px solid var(--panel-border)", paddingTop: "0.4rem" }}>
      {METRICS.map((def) => {
        const reading = report.readings[def.id];
        if (reading.value === null) return null;
        return (
          <div key={def.id} className="stack" style={{ gap: "0.05rem" }}>
            <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.75rem" }}>
              <span title={def.blurb}>{def.label}</span>
              <strong style={{ fontVariantNumeric: "tabular-nums" }}>{def.format(reading.value)}</strong>
            </div>
            <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.66rem" }}>
              <span className="muted">
                {reading.rank !== null
                  ? t(`#${reading.rank} of ${reading.rankOf}`, `#${reading.rank} sur ${reading.rankOf}`)
                  : `n = ${reading.sample}`}
              </span>
              {reading.field !== null && reading.edge !== null ? (
                <span style={{ color: reading.edge >= 0 ? "var(--accent)" : "var(--text-dim)" }}>
                  {t(
                    `field ${def.format(reading.field)} · ${reading.edge >= 0 ? "+" : ""}${reading.edge.toFixed(1)} spread`,
                    `terrain ${def.format(reading.field)} · ${reading.edge >= 0 ? "+" : ""}${reading.edge.toFixed(1)} écart`
                  )}
                </span>
              ) : (
                <span className="muted">{t("no field baseline yet", "pas encore de référence de terrain")}</span>
              )}
            </div>
            <Bar reading={reading} def={def} />
          </div>
        );
      })}
      {report.supporting.length > 0 && (
        <span className="muted" style={{ fontSize: "0.68rem" }}>
          {t("Also above the field on:", "Aussi au-dessus du terrain sur :")}{" "}
          {report.supporting.map((tr) => tr.name).join(", ")}.
        </span>
      )}
    </div>
  );
}

/**
 * The value drawn against the field, with the field itself at the halfway mark.
 *
 * Deliberately not a percentile bar. A percentile needs a distribution to sit in, and with a
 * handful of qualified captains there isn't one - "half the bar is average" is a claim the sample
 * can actually support.
 */
function Bar({ reading, def }: { reading: MetricReading; def: MetricDef }) {
  // Without a baseline there is nothing to draw a bar against, so the row stays numbers only.
  if (reading.value === null || reading.field === null || reading.field === 0) return null;
  const ratio =
    def.better === "higher" ? reading.value / (2 * reading.field) : reading.field / (2 * reading.value);
  return (
    <div style={{ height: 4, borderRadius: 2, background: "var(--cell)", overflow: "hidden" }}>
      <div
        style={{
          width: `${Math.round(Math.max(0.04, Math.min(1, ratio)) * 100)}%`,
          height: "100%",
          background: (reading.edge ?? 0) >= 0 ? "var(--accent)" : "var(--panel-border)",
        }}
      />
    </div>
  );
}

/** One big number on the face of the card. */
function Headline({ report, id }: { report: ScoutingReport; id: MetricDef["id"] }) {
  const def = METRICS.find((m) => m.id === id);
  const reading = report.readings[id];
  if (!def || reading.value === null) return null;
  return (
    <div className="stack" style={{ gap: 0, minWidth: "4.5rem" }}>
      <span style={{ fontSize: "1.1rem", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
        {def.format(reading.value)}
      </span>
      <span className="muted" style={{ fontSize: "0.64rem" }}>
        {def.label}
      </span>
    </div>
  );
}
