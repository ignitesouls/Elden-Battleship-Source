import { useEffect, useState } from "react";
import { fetchCopypastas, type Copypasta } from "../lib/copypastas";
import { isSupabaseConfigured } from "../lib/supabase";
import { barnacleSrc } from "../lib/barnacles";
import { useT } from "../lib/language";

/**
 * The community's copypastas on the caster desk, each one click from being said over the board.
 *
 * Read once, when the group is first opened (DeskMenu's `lazy`), so a desk that never opens it costs
 * nothing. The list is the administrators' - see components/admin/CopypastaEditor - so there is nothing
 * to edit here; Refresh picks up a change made mid-show.
 */
export function DeskCopypastas({ onShow }: { onShow: (c: Copypasta) => void }) {
  const t = useT();
  const [rows, setRows] = useState<Copypasta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = () => {
    if (!isSupabaseConfigured) return;
    setError(null);
    fetchCopypastas()
      .then(setRows)
      .catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);

  const q = filter.trim().toLowerCase();
  const shown = (rows ?? []).filter((c) => !q || c.title.toLowerCase().includes(q) || c.body.toLowerCase().includes(q));

  return (
    <section>
      <div className="row" style={{ gap: "0.4rem" }}>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("Find one", "En chercher un")}
          aria-label={t("Find a copypasta", "Chercher un copypasta")}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button onClick={load} title={t("Read the list again", "Relire la liste")}>
          {t("Refresh", "Actualiser")}
        </button>
      </div>
      {error && <span className="error-text">{error}</span>}
      {rows === null && !error ? (
        <span className="muted" style={{ fontSize: "0.75rem" }}>{t("Loading...", "Chargement...")}</span>
      ) : rows !== null && rows.length === 0 ? (
        <span className="muted" style={{ fontSize: "0.75rem" }}>
          {t("No copypastas yet - an administrator adds them on the Admin page.", "Pas encore de copypastas - un administrateur les ajoute sur la page Admin.")}
        </span>
      ) : (
        <div className="stack" style={{ gap: "0.35rem", maxHeight: "18rem", overflowY: "auto" }}>
          {shown.map((c) => (
            <div key={c.id} className="row" style={{ gap: "0.45rem", alignItems: "center", fontSize: "0.78rem" }}>
              <img src={barnacleSrc(c.mood)} alt="" style={{ width: "1.2rem", height: "1.2rem", objectFit: "contain", flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }} title={c.body}>
                <strong>{c.title}</strong>
                <span className="muted" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.body}
                </span>
              </span>
              <button className="primary" onClick={() => onShow(c)} style={{ flexShrink: 0, fontSize: "0.7rem" }}>
                {t("Show", "Afficher")}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
