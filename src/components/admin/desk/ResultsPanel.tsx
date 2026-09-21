import { useState } from "react";
import { enterScore, forfeitMatchById, setMatchTime } from "../../../lib/tournament/api";
import { fromLocalInput, toLocalInput } from "../../../lib/tournament/localTime";
import { winsNeeded, type TMatch } from "../../../lib/tournament/types";
import { useLanguage, useT } from "../../../lib/language";
import type { DeskAct } from "./OverduePanel";
import type { DeskData } from "./useDeskData";

/**
 * The time two teams have agreed to play. Set with an explicit button rather than on every change: a
 * date-time field reports a change as each part is picked, and every one of those would otherwise be a
 * database write followed by a reload that redraws the field under the person typing.
 */
function AgreedTime({ initial, busy, onSet }: { initial: string | null; busy: boolean; onSet: (iso: string | null) => void }) {
  const t = useT();
  const [value, setValue] = useState(toLocalInput(initial));
  const changed = value !== toLocalInput(initial);
  return (
    <div className="row" style={{ gap: "0.3rem" }}>
      <span className="muted" style={{ fontSize: "0.72rem" }}>{t("agreed time", "heure convenue")}</span>
      <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} style={{ fontSize: "0.78rem", padding: "0.15rem 0.35rem" }} />
      <button style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }} disabled={busy || !changed} onClick={() => onSet(fromLocalInput(value))}>
        {value ? t("Set", "Fixer") : t("Clear", "Effacer")}
      </button>
    </div>
  );
}

/**
 * Enter, correct and revert results, forfeit a match, and record when two teams have agreed to play.
 *
 * Every write goes to the database function that owns the rule - a score that no series can produce, or
 * a correction that would contradict a match already played downstream, is refused there, with its
 * reason, and shown here as written. Nothing is validated twice.
 */
export function ResultsPanel({ data, act, busy }: { data: DeskData; act: DeskAct; busy: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const [showDone, setShowDone] = useState(false);
  const [scores, setScores] = useState<Record<string, { a: number; b: number }>>({});
  const stored = data.stored;
  if (!stored) return null;

  const playable = stored.matches.filter((m) => m.a && m.b && m.status !== "skipped");
  // Qualifier before knockout, then by round: each stage numbers its rounds from 1, so round alone would
  // interleave a Swiss round 1 with a knockout round 1.
  const stageRank = { swiss: 0, group: 1, knockout: 2 } as const;
  const rows = playable
    .filter((m) => showDone || m.status !== "done")
    .sort((x, y) => stageRank[x.stage] - stageRank[y.stage] || x.phase - y.phase || x.index - y.index || (x.key < y.key ? -1 : 1));
  const doneCount = playable.filter((m) => m.status === "done").length;

  const day = (iso: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-FR" : undefined, { month: "short", day: "numeric" });
  const draft = (m: TMatch) => scores[m.key] ?? { a: m.scoreA, b: m.scoreB };
  return (
    <div className="panel stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0, border: "none", padding: 0 }}>{t("Results", "Résultats")}</h3>
        <label className="row" style={{ gap: "0.4rem" }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          <span className="muted">{t(`Show played matches (${doneCount})`, `Afficher les matchs joués (${doneCount})`)}</span>
        </label>
      </div>

      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{t("Nothing waiting to be played.", "Rien en attente d'être joué.")}</p>
      ) : (
        <div className="t-list">
          {rows.map((m) => {
            const id = stored.ids.get(m.key)!;
            const a = data.names.get(m.a!) ?? "?";
            const b = data.names.get(m.b!) ?? "?";
            const need = winsNeeded(m.bestOf);
            const d = draft(m);
            const changed = d.a !== m.scoreA || d.b !== m.scoreB;
            const decided = m.status === "done";
            return (
              <div className="t-item" key={m.key} style={{ alignItems: "flex-start" }}>
                <div className="stack" style={{ gap: "0.15rem", flex: 1, minWidth: "13rem" }}>
                  <span>
                    <span className={decided && m.winner === m.a ? "t-winner" : undefined}>{a}</span>{" "}
                    <span className="muted">{t("vs", "contre")}</span>{" "}
                    <span className={decided && m.winner === m.b ? "t-winner" : undefined}>{b}</span>
                    {m.resultKind === "forfeit" && <span className="badge badge--bad" style={{ marginLeft: "0.4rem" }}>{t("forfeit", "forfait")}</span>}
                    {m.resultKind === "admin" && decided && <span className="badge" style={{ marginLeft: "0.4rem" }}>{t("entered by an admin", "saisi par un admin")}</span>}
                  </span>
                  <span className="muted" style={{ fontSize: "0.75rem" }}>
                    {t(`${m.stage} round ${m.phase}`, `${m.stage} tour ${m.phase}`)} · {t(`first to ${need}`, `premier à ${need}`)}
                    {m.dueAt && ` · ${t("due", "avant le")} ${day(m.dueAt)}`}
                  </span>
                  {!decided && (
                    <AgreedTime
                      initial={stored.agreed.get(m.key) ?? null}
                      busy={busy}
                      onSet={(iso) => void act(() => setMatchTime(id, iso))}
                    />
                  )}
                </div>

                <div className="stack" style={{ gap: "0.3rem", alignItems: "flex-end" }}>
                  <div className="row" style={{ gap: "0.3rem" }}>
                    <input type="number" min={0} max={need} value={d.a} aria-label={t(`${a} games`, `manches de ${a}`)}
                      onChange={(e) => setScores({ ...scores, [m.key]: { ...d, a: Number(e.target.value) } })} style={{ width: "3.6rem", textAlign: "center" }} />
                    <span className="muted">-</span>
                    <input type="number" min={0} max={need} value={d.b} aria-label={t(`${b} games`, `manches de ${b}`)}
                      onChange={(e) => setScores({ ...scores, [m.key]: { ...d, b: Number(e.target.value) } })} style={{ width: "3.6rem", textAlign: "center" }} />
                    <button className="primary" disabled={busy || !changed} onClick={() => void act(() => enterScore(id, d.a, d.b))}>
                      {t("Save", "Enregistrer")}
                    </button>
                  </div>
                  <div className="row" style={{ gap: "0.3rem" }}>
                    {!decided && (
                      <>
                        <button style={{ fontSize: "0.78rem", padding: "0.25rem 0.55rem" }} disabled={busy} onClick={() => void act(() => forfeitMatchById(id, "a"))}>
                          {t(`${a} forfeits`, `${a} forfait`)}
                        </button>
                        <button style={{ fontSize: "0.78rem", padding: "0.25rem 0.55rem" }} disabled={busy} onClick={() => void act(() => forfeitMatchById(id, "b"))}>
                          {t(`${b} forfeits`, `${b} forfait`)}
                        </button>
                      </>
                    )}
                    {(decided || m.scoreA + m.scoreB > 0) && (
                      <button className="danger" style={{ fontSize: "0.78rem", padding: "0.25rem 0.55rem" }} disabled={busy}
                        onClick={() => { if (window.confirm(t("Clear this result?", "Effacer ce résultat ?"))) void act(async () => { await enterScore(id, 0, 0); setScores({ ...scores, [m.key]: { a: 0, b: 0 } }); }); }}>
                        {t("Revert", "Annuler le résultat")}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
