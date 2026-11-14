import type { ReactNode } from "react";
import type { Branch, Outlook, ResultRef } from "../../lib/tournament/clinch";
import type { StandingRow } from "../../lib/tournament/standings";
import { useT } from "../../lib/language";
import { EntrantLabel } from "./TeamLogo";

interface Props {
  /** One table and its outlooks per group (or the single Swiss table). */
  tables: StandingRow[][];
  outlooks: Outlook[][];
  cuts: number[];
  titles: (string | undefined)[];
  names: Map<string, string>;
  logos?: Map<string, string>;
  twitch?: Map<string, string>;
  eventId?: string;
  swiss: boolean;
}

/** Results elsewhere listed in one line before the rest are counted. */
const SHOWN_RESULTS = 3;

/**
 * The playoff picture: per table, who has clinched, who is out, and for everyone still in the hunt
 * what it would take - the fewest wins that clinch, the fewest losses that end it, and (in a group)
 * what each result of their next match would mean. Worked out in clinch.ts, on wins alone, so nothing
 * here is ever taken back - see the note at the bottom.
 */
export function PlayoffPicture({ tables, outlooks, cuts, titles, names, logos, twitch, eventId, swiss }: Props) {
  const t = useT();
  const name = (id: string) => names.get(id) ?? "?";
  const label = (id: string) => <EntrantLabel eventId={eventId} teamId={id} name={name(id)} logo={logos?.get(id)} twitch={twitch?.get(id)} />;
  const wins = (n: number) => t(n === 1 ? "1 more win" : `${n} more wins`, n === 1 ? "1 victoire de plus" : `${n} victoires de plus`);
  const losses = (n: number) => t(n === 1 ? "1 more loss" : `${n} more losses`, n === 1 ? "1 défaite de plus" : `${n} défaites de plus`);

  const results = (list: ResultRef[]) => {
    const shown = list.slice(0, SHOWN_RESULTS).map((r) => t(`${name(r.winner)} beats ${name(r.loser)}`, `${name(r.winner)} bat ${name(r.loser)}`));
    const more = list.length - shown.length;
    return shown.join(t(" or ", " ou ")) + (more > 0 ? t(` (or ${more} other results)`, ` (ou ${more} autres résultats)`) : "");
  };

  const branch = (b: Branch): ReactNode => {
    if (b.fate === "clinched") return <span className="badge badge--good">{t("clinched", "qualifiée")}</span>;
    if (b.fate === "eliminated") return <span className="badge">{t("eliminated", "éliminée")}</span>;
    const parts: string[] = [];
    if (b.clinchIf.length > 0) parts.push(t(`clinches if ${results(b.clinchIf)}`, `qualifiée si ${results(b.clinchIf)}`));
    if (b.outIf.length > 0) parts.push(t(`out if ${results(b.outIf)}`, `éliminée si ${results(b.outIf)}`));
    return parts.length > 0 ? parts.join("; ") : t("still in the hunt", "toujours en course");
  };

  return (
    <div className="stack">
      {tables.map((table, g) => {
        const looks = new Map(outlooks[g]?.map((o) => [o.id, o] as const));
        const ofFate = (fate: Outlook["fate"]) => table.filter((row) => looks.get(row.id)?.fate === fate && !looks.get(row.id)?.awaitingTiebreak);
        const clinched = ofFate("clinched");
        const out = ofFate("eliminated");
        const alive = table.filter((row) => looks.get(row.id)?.fate === "alive" || looks.get(row.id)?.awaitingTiebreak);
        const cut = cuts[g] ?? 0;
        return (
          <div key={g} className="stack" style={{ gap: "0.5rem" }}>
            {titles[g] && <h4 className="group-heading">{titles[g]}</h4>}
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              {t(`${cut} ${cut === 1 ? "place" : "places"} in the knockout`, `${cut} ${cut === 1 ? "place" : "places"} en élimination`)}
              {clinched.length > 0 && t(` - ${clinched.length} taken`, ` - ${clinched.length} prise${clinched.length === 1 ? "" : "s"}`)}
            </span>

            {clinched.length > 0 && (
              <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
                <span className="badge badge--good">{t("clinched", "qualifiées")}</span>
                {clinched.map((row) => <span key={row.id}>{label(row.id)}</span>)}
              </div>
            )}

            {alive.map((row) => {
              const o = looks.get(row.id)!;
              const lines: ReactNode[] = [];
              if (o.awaitingTiebreak) {
                lines.push(t("Level with another team at the line on every tiebreak - a tiebreaker match decides it.", "À égalité à la limite sur tous les critères - un match de barrage décidera."));
              } else if (o.remaining === 0) {
                lines.push(t("Done playing - it now depends on the other results.", "A fini de jouer - tout dépend maintenant des autres résultats."));
              } else {
                if (o.clinchWith !== null) {
                  lines.push(
                    o.clinchWith === o.remaining && o.remaining > 1
                      ? t(`Clinches by winning all ${o.remaining} it has left.`, `Qualifiée en gagnant les ${o.remaining} matchs restants.`)
                      : t(`Clinches with any ${wins(o.clinchWith)}.`, `Qualifiée avec ${wins(o.clinchWith)}, quels qu'ils soient.`),
                  );
                } else if (o.ownDestiny) {
                  lines.push(t("Clinches by winning out.", "Qualifiée en gagnant tout."));
                } else {
                  lines.push(t("Needs help: winning everything it has left is not enough on its own.", "A besoin d'aide : tout gagner ne suffit pas à lui seul."));
                }
                if (o.outWith !== null) lines.push(t(`Out with any ${losses(o.outWith)}.`, `Éliminée avec ${losses(o.outWith)}, quelles qu'elles soient.`));
              }
              return (
                <div key={row.id} className="panel stack" style={{ gap: "0.3rem", padding: "0.5rem 0.7rem" }}>
                  <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
                    <strong>{label(row.id)}</strong>
                    <span className="muted" style={{ fontSize: "0.8rem" }}>
                      {`${row.wins}-${row.losses}`}
                      {o.remaining > 0 && t(` · ${o.remaining} left`, ` · ${o.remaining} restant${o.remaining === 1 ? "" : "s"}`)}
                    </span>
                  </div>
                  {lines.map((line, i) => (
                    <span key={i} style={{ fontSize: "0.85rem" }}>{line}</span>
                  ))}
                  {o.next && (
                    <div className="stack" style={{ gap: "0.15rem", fontSize: "0.85rem" }}>
                      <span className="muted">{t("Next match:", "Prochain match :")}</span>
                      <span>
                        {t("Beat ", "Bat ")}
                        {name(o.next.opponent)}: {branch(o.next.win)}
                      </span>
                      <span>
                        {t("Lose to ", "Perd contre ")}
                        {name(o.next.opponent)}: {branch(o.next.loss)}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}

            {out.length > 0 && (
              <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap", alignItems: "center", opacity: 0.7 }}>
                <span className="badge">{t("eliminated", "éliminées")}</span>
                {out.map((row) => <span key={row.id}>{label(row.id)}</span>)}
              </div>
            )}
          </div>
        );
      })}

      <span className="muted" style={{ fontSize: "0.75rem" }}>
        {t(
          "Worked out on wins alone. A team that could still finish level on wins at the line is neither clinched nor out, because the tiebreakers can't be known in advance - so a marker, once shown, never comes off.",
          "Calculé sur les seules victoires. Une équipe qui peut encore finir à égalité de victoires à la limite n'est ni qualifiée ni éliminée, car les critères de départage ne se prévoient pas - un marqueur affiché ne disparaît donc jamais.",
        )}
        {swiss &&
          " " +
            t(
              "Swiss pairings are drawn round by round, so this counts at most one win per round left for every team, whoever they end up playing.",
              "Les appariements suisses sont tirés ronde par ronde : on compte donc au plus une victoire par ronde restante pour chaque équipe, quel que soit son adversaire.",
            )}
      </span>
    </div>
  );
}
