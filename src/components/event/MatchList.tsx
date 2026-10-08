import type { MatchRow } from "../../lib/tournament/api";
import { useLanguage, useT } from "../../lib/language";
import { groupLabel } from "../../lib/tournament/groupNames";
import type { TeamPowerInfo } from "../../hooks/useTeamPowers";
import { MatchOdds } from "./PowerLine";
import { TeamLogo } from "./TeamLogo";

/**
 * Every match of a running or finished event, grouped by round.
 *
 * A plain list on purpose, for now: it answers the questions a player has - who am I playing, by when,
 * what happened - without depending on a bracket drawing, and it is right for every format, including
 * Swiss and groups where there is no bracket to draw. A drawn bracket can be added on top of the same
 * data later without this having to change.
 *
 * Rounds are grouped by `phase`, not `round`: in a double elimination the winners and loser brackets
 * run side by side, and it is the phase that says which matches are due in the same window.
 */

interface Props {
  matches: MatchRow[];
  /** Team names by id. A match whose team is not in the map (not public yet) shows as "TBD". */
  names: Map<string, string>;
  /** The event's group names, so a group match can say which group it is in. */
  groupNames?: string[];
  /** Team power by team id: matches still to be played show their line. */
  powers?: Map<string, TeamPowerInfo> | null;
  /** Logo addresses by team id. Given, every named team shows its logo (or the default) beside its name. */
  logos?: Map<string, string>;
}

const BRACKET_LABEL: Record<string, [string, string]> = {
  W: ["Winners", "Vainqueurs"],
  L: ["Losers", "Repêchage"],
  GF: ["Grand final", "Grande finale"],
  TP: ["Third place", "Troisième place"],
};

export function MatchList({ matches, names, groupNames, powers, logos }: Props) {
  const t = useT();
  const lang = useLanguage();

  if (matches.length === 0) {
    return <p className="muted">{t("No matches have been drawn yet.", "Aucun match n'a encore été tiré.")}</p>;
  }

  // Qualifier before knockout, then round by round. Swiss, group and knockout rounds all count from 1, so
  // ordering by round alone would interleave them ("Swiss 1, Knockout 1, Swiss 2 ...").
  const stageRank = { swiss: 0, group: 1, knockout: 2 } as const;
  const ordered = [...matches].sort(
    (x, y) => stageRank[x.stage] - stageRank[y.stage] || (x.phase ?? x.round) - (y.phase ?? y.round) || x.idx - y.idx,
  );

  // Group by stage then phase, in that order.
  const groups = new Map<string, { label: string; rows: MatchRow[] }>();
  for (const match of ordered) {
    const phase = match.phase ?? match.round;
    const key = `${match.stage}:${phase}`;
    if (!groups.has(key)) {
      const stage =
        match.stage === "swiss"
          ? t("Swiss", "Suisse")
          : match.stage === "group"
            ? t("Groups", "Poules")
            : t("Knockout", "Élimination");
      groups.set(key, { label: `${stage} · ${t("Round", "Tour")} ${phase}`, rows: [] });
    }
    groups.get(key)!.rows.push(match);
  }

  // "Winners" only means something next to a loser bracket. In a single elimination every match is in
  // the one bracket, and tagging each of them would be noise; the special matches (a third-place
  // playoff, a grand final) are worth naming either way.
  const hasLosers = matches.some((m) => m.bracket === "L" || m.bracket === "GF");
  const showBracket = (bracket: string | null) => !!bracket && (hasLosers || bracket !== "W");
  // Group rounds list every group's matches together, so each one says which group it belongs to - unless
  // there is only the one group, where it would say the same thing on every line.
  const manyGroups = new Set(matches.filter((m) => m.stage === "group").map((m) => m.grp)).size > 1;

  const when = (iso: string) =>
    new Date(iso).toLocaleString(lang === "fr" ? "fr-FR" : undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-FR" : undefined, { month: "short", day: "numeric" });

  return (
    <div className="stack" style={{ gap: "1rem" }}>
      {[...groups.values()].map((group) => (
        <div key={group.label}>
          <h3 style={{ marginBottom: "0.25rem" }}>{group.label}</h3>
          <div className="t-list">
            {group.rows.map((m) => {
              const a = m.entrant_a ? names.get(m.entrant_a) ?? "?" : t("TBD", "À déterminer");
              const b = m.entrant_b ? names.get(m.entrant_b) ?? "?" : t("TBD", "À déterminer");
              const done = m.status === "done";
              const bracket = showBracket(m.bracket) && m.bracket ? BRACKET_LABEL[m.bracket] : null;
              return (
                <div className="t-item" key={m.id}>
                  <span style={{ flex: 1, minWidth: "12rem" }}>
                    {logos && <TeamLogo url={m.entrant_a ? logos.get(m.entrant_a) : null} empty={!m.entrant_a} size={1.15} />}{logos && " "}
                    <span className={done && m.winner === m.entrant_a ? "t-winner" : undefined}>{a}</span>
                    <span className="muted"> {t("vs", "contre")} </span>
                    {logos && <TeamLogo url={m.entrant_b ? logos.get(m.entrant_b) : null} empty={!m.entrant_b} size={1.15} />}{logos && " "}
                    <span className={done && m.winner === m.entrant_b ? "t-winner" : undefined}>{b}</span>
                    {bracket && (
                      <span className="muted" style={{ fontSize: "0.72rem" }}>
                        {" "}
                        · {t(bracket[0], bracket[1])}
                      </span>
                    )}
                    {manyGroups && m.stage === "group" && m.grp !== null && (
                      <span className="muted" style={{ fontSize: "0.72rem" }}>
                        {" "}
                        · {groupLabel(groupNames, m.grp, lang)}
                      </span>
                    )}
                  </span>

                  <span className="row" style={{ gap: "0.5rem" }}>
                    {(done || m.status === "in_progress") && (
                      <span className="t-score">
                        {m.score_a} - {m.score_b}
                      </span>
                    )}
                    {m.result_kind === "forfeit" && <span className="badge badge--bad">{t("forfeit", "forfait")}</span>}
                    {m.status === "in_progress" && <span className="badge badge--warn">{t("in progress", "en cours")}</span>}
                    {m.status === "ready" && !m.agreed_at && <span className="badge">{t("to be played", "à jouer")}</span>}
                    {m.status === "ready" && m.agreed_at && (
                      <span className="badge badge--good" title={t("Agreed time", "Heure convenue")}>
                        {when(m.agreed_at)}
                      </span>
                    )}
                    {(m.status === "ready" || m.status === "in_progress") && m.due_at && (
                      <span className="muted" style={{ fontSize: "0.72rem" }}>
                        {t("due", "avant le")} {day(m.due_at)}
                      </span>
                    )}
                  </span>
                  {/* The line, for a match still to be decided with both teams known. */}
                  {powers && m.entrant_a && m.entrant_b && (m.status === "ready" || m.status === "in_progress" || m.status === "pending") && (
                    <div style={{ flexBasis: "100%" }}>
                      <MatchOdds a={powers.get(m.entrant_a)} b={powers.get(m.entrant_b)} nameA={a} nameB={b} bestOf={m.best_of} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
