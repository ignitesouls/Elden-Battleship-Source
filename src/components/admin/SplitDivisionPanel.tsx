import { useState } from "react";
import type { AdminTeamRow, EventDetail } from "../../lib/tournament/api";
import { useT } from "../../lib/language";
import type { TeamPowerInfo } from "../../hooks/useTeamPowers";
import { PowerTag } from "../event/PowerLine";

interface Props {
  event: EventDetail;
  /** The teams still in the event, in the order to list them (the seeding, then any awaiting approval). */
  teams: AdminTeamRow[];
  powers?: Map<string, TeamPowerInfo> | null;
  busy: boolean;
  onSplit: (entrantIds: string[], name: string, thisLabel: string, newLabel: string) => void;
}

/**
 * Splits some of the event's teams off into a division of their own: a separate, linked event with its
 * own format, schedule, playoffs and champion (see split_division). The organizer ticks the teams that
 * go, names the new event, and labels both divisions for the switcher between them.
 *
 * Collapsed by default - most events are never split - and only offered before the event starts.
 */
export function SplitDivisionPanel({ event, teams, powers, busy, onSplit }: Props) {
  const t = useT();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState(`${event.name} - ${t("Lower Division", "Division inférieure")}`);
  const [thisLabel, setThisLabel] = useState(event.division_name || t("Upper Division", "Division supérieure"));
  const [newLabel, setNewLabel] = useState(t("Lower Division", "Division inférieure"));

  const toggle = (id: string) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const staying = teams.length - picked.size;
  const problem =
    picked.size === 0
      ? t("Tick the teams that go in the new division.", "Cochez les équipes de la nouvelle division.")
      : staying === 0
        ? t("Leave at least one team in this event.", "Laissez au moins une équipe dans cet événement.")
        : name.trim().length < 3
          ? t("Give the new division a name.", "Donnez un nom à la nouvelle division.")
          : null;

  const split = () => {
    const ok = window.confirm(
      t(
        `Move ${picked.size} team${picked.size === 1 ? "" : "s"} into a new event, "${name.trim()}"?\n\nThey leave "${event.name}" with their rosters and play only in their own division from then on. This event's plan is saved first.`,
        `Déplacer ${picked.size} équipe(s) dans un nouvel événement, « ${name.trim()} » ?\n\nElles quittent « ${event.name} » avec leurs effectifs et ne jouent plus que dans leur propre division. Le plan de cet événement est d'abord enregistré.`,
      ),
    );
    if (ok) onSplit([...picked], name.trim(), thisLabel.trim(), newLabel.trim());
  };

  return (
    <details className="panel">
      <summary style={{ cursor: "pointer" }}>
        <strong>{t("Divisions: split teams off into their own event", "Divisions : séparer des équipes dans leur propre événement")}</strong>
      </summary>
      <div className="stack" style={{ marginTop: "0.7rem", gap: "0.7rem" }}>
        <p className="muted" style={{ margin: 0 }}>
          {t(
            "The teams you tick move into a new event linked to this one - a division of their own, with its own format, groups, weeks, playoffs and champion. The two never meet. Each division's page links to the other. Rosters, logos and entry codes go with the teams; if this event has a saved plan, the new division starts from a copy of it.",
            "Les équipes cochées passent dans un nouvel événement lié à celui-ci - leur propre division, avec son format, ses poules, ses semaines, sa phase finale et son champion. Les deux ne se rencontrent jamais. La page de chaque division renvoie vers l'autre. Effectifs, logos et codes d'entrée suivent les équipes ; si cet événement a un plan enregistré, la nouvelle division part d'une copie.",
          )}
        </p>

        <div className="t-list">
          {teams.map((team) => (
            <label key={team.id} className="t-item" style={{ cursor: "pointer", justifyContent: "flex-start", gap: "0.6rem" }}>
              <input type="checkbox" checked={picked.has(team.id)} disabled={busy} onChange={() => toggle(team.id)} />
              <span>
                {team.name} <PowerTag info={powers?.get(team.id)} />
                {team.status === "pending" && <span className="muted" style={{ fontSize: "0.8rem" }}> · {t("awaiting approval", "en attente d'approbation")}</span>}
              </span>
            </label>
          ))}
        </div>

        <div className="row" style={{ alignItems: "flex-end", gap: "0.6rem 1rem" }}>
          <label className="stack" style={{ gap: "0.25rem", flex: "1 1 18rem" }}>
            <span className="muted">{t("New event's name", "Nom du nouvel événement")}</span>
            <input value={name} maxLength={80} disabled={busy} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="stack" style={{ gap: "0.25rem" }}>
            <span className="muted">{t("This division is", "Cette division est")}</span>
            <input value={thisLabel} maxLength={40} disabled={busy} onChange={(e) => setThisLabel(e.target.value)} />
          </label>
          <label className="stack" style={{ gap: "0.25rem" }}>
            <span className="muted">{t("The new one is", "La nouvelle est")}</span>
            <input value={newLabel} maxLength={40} disabled={busy} onChange={(e) => setNewLabel(e.target.value)} />
          </label>
        </div>

        <div className="row" style={{ gap: "0.8rem" }}>
          <button className="primary" disabled={busy || problem !== null} onClick={split}>
            {t(`Split ${picked.size} team${picked.size === 1 ? "" : "s"} into a new division`, `Séparer ${picked.size} équipe(s) dans une nouvelle division`)}
          </button>
          <span className="muted">{problem ?? t(`${staying} stay${staying === 1 ? "s" : ""} here.`, `${staying} reste(nt) ici.`)}</span>
        </div>
      </div>
    </details>
  );
}
