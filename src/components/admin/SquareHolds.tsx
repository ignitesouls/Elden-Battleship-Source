import { squareSet } from "../../lib/challenges";
import type { Challenge, SquareHold } from "../../lib/squareSetFormat";
import { useT } from "../../lib/language";

/**
 * Boss squares taken out of the deal, and why - see Challenge.holds.
 *
 * Read-only on purpose. A hold has to ship with the code that deals boards (the six functions and the
 * site all rebuild boards from the boss lists), so it is set by scripts/hold-square.mjs and a deploy,
 * never by a button here: a database switch would let a player's page and the server disagree about
 * which boss sits on a cell. This panel is where an admin sees what is out and how to change it.
 */
export function SquareHolds() {
  const t = useT();
  const lists: Array<[string, Challenge[]]> = [];
  for (const id of ["bosses", "bosses-2v2"]) {
    const set = squareSet(id);
    if (set.format === "flat") lists.push([set.cutLabel ?? set.label, set.data]);
  }
  // One row per square, naming the cuts it is in - hold-square.mjs keeps the copies identical.
  const rows = new Map<string, { holds: SquareHold[]; cuts: string[] }>();
  for (const [cut, list] of lists) {
    for (const sq of list) {
      if (!sq.holds?.length) continue;
      const row = rows.get(sq.name) ?? { holds: sq.holds, cuts: [] };
      row.cuts.push(cut);
      rows.set(sq.name, row);
    }
  }
  const when = (iso: string) => new Date(iso).toLocaleString();

  return (
    <div className="panel stack" style={{ gap: "0.6rem", width: "100%" }}>
      <h2 style={{ margin: 0, fontSize: "1rem" }}>{t("Boss holds", "Boss retirés")}</h2>
      <p className="muted" style={{ margin: 0, fontSize: "0.76rem" }}>
        {t(
          "Bosses taken out of the deal because they can't be finished - a kill Dionysus can't register. Boards dealt during a hold never have the boss; every other board is untouched. Players see the note in the lobby.",
          "Boss retirés de la distribution parce qu'ils ne peuvent pas être terminés - une mise à mort que Dionysus ne détecte pas. Les plateaux distribués pendant un retrait n'ont jamais ce boss ; les autres ne changent pas. Les joueurs voient la note dans le salon."
        )}
      </p>

      {rows.size === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>{t("Every boss is in the deal.", "Tous les boss sont distribués.")}</p>
      ) : (
        [...rows].map(([name, { holds, cuts }]) => (
          <div key={name} className="stack" style={{ gap: "0.2rem" }}>
            <strong style={{ fontSize: "0.85rem" }}>
              {name} <span className="muted" style={{ fontWeight: "normal", fontSize: "0.74rem" }}>· {cuts.join(", ")}</span>
            </strong>
            {holds.map((h) => (
              <span key={h.from} style={{ fontSize: "0.78rem" }}>
                <span style={{ color: h.until ? "var(--text-dim)" : "var(--accent)" }}>
                  {h.until
                    ? t(`Held ${when(h.from)} - ${when(h.until)}`, `Retiré du ${when(h.from)} au ${when(h.until)}`)
                    : t(`Out since ${when(h.from)}`, `Retiré depuis le ${when(h.from)}`)}
                </span>
                {t(", due to ", ", en raison ")}
                {t(h.note, h.noteFr ?? h.note)}
              </span>
            ))}
          </div>
        ))
      )}

      <p className="muted" style={{ margin: 0, fontSize: "0.72rem" }}>
        {t("To hold or return a boss, with no matches live, then deploy straight after:", "Pour retirer ou remettre un boss, sans partie en cours, puis déployer aussitôt :")}
        <br />
        <code>node scripts/hold-square.mjs Romina "what is wrong"</code>
        <br />
        <code>node scripts/hold-square.mjs Romina return</code>
      </p>
    </div>
  );
}
