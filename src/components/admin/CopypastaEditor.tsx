import { useEffect, useState } from "react";
import {
  COPYPASTA_BODY_MAX,
  COPYPASTA_TITLE_MAX,
  deleteCopypasta,
  fetchCopypastas,
  saveCopypasta,
  type Copypasta,
} from "../../lib/copypastas";
import { MoodPicker } from "../DeskAnnounce";
import { useT } from "../../lib/language";

type Draft = Omit<Copypasta, "id"> & { id?: string };

const blank = (sort: number): Draft => ({ title: "", body: "", mood: "happy", sort });

/** One copypasta's fields, for a new one or an existing one. */
function CopypastaForm({
  draft,
  busy,
  onChange,
  onSave,
  onDelete,
}: {
  draft: Draft;
  busy: boolean;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const ready = draft.title.trim().length > 0 && draft.body.trim().length > 0;
  return (
    <div className="stack" style={{ gap: "0.35rem", padding: "0.5rem", border: "1px solid var(--panel-border)", borderRadius: 6 }}>
      <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
        <input
          value={draft.title}
          maxLength={COPYPASTA_TITLE_MAX}
          placeholder={t("Name it (what the desk lists it as)", "Son nom (affiché sur le poste)")}
          aria-label={t("Name", "Nom")}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
          style={{ flex: 1, minWidth: "12rem" }}
        />
        <label className="row muted" style={{ gap: "0.3rem", fontSize: "0.75rem" }}>
          {t("Order", "Ordre")}
          <input
            type="number"
            value={draft.sort}
            onChange={(e) => onChange({ ...draft, sort: Number(e.target.value) || 0 })}
            style={{ width: "4.5rem" }}
          />
        </label>
      </div>
      <textarea
        value={draft.body}
        maxLength={COPYPASTA_BODY_MAX}
        rows={3}
        placeholder={t("What the barnacle says", "Ce que dit le bernacle")}
        aria-label={t("Text", "Texte")}
        onChange={(e) => onChange({ ...draft, body: e.target.value })}
        style={{ width: "100%", resize: "vertical" }}
      />
      <div className="row" style={{ gap: "0.5rem", justifyContent: "space-between", flexWrap: "wrap" }}>
        <MoodPicker mood={draft.mood} onChange={(mood) => onChange({ ...draft, mood })} />
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          {draft.body.length}/{COPYPASTA_BODY_MAX}
        </span>
        <span className="row" style={{ gap: "0.4rem" }}>
          {onDelete && (
            <button className="danger" disabled={busy} onClick={onDelete}>
              {t("Delete", "Supprimer")}
            </button>
          )}
          <button className="primary" disabled={busy || !ready} onClick={onSave}>
            {draft.id ? t("Save", "Enregistrer") : t("Add", "Ajouter")}
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * The caster desk's copypastas (lib/copypastas): add, fix, reorder or retire them.
 *
 * A change reaches a desk the next time its Copypastas group is opened, or when the caster presses
 * Refresh - nothing here pushes to a desk that is already open.
 */
export function CopypastaEditor() {
  const t = useT();
  const [rows, setRows] = useState<Copypasta[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [fresh, setFresh] = useState<Draft>(blank(0));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    const list = await fetchCopypastas();
    setRows(list);
    setDrafts(Object.fromEntries(list.map((c) => [c.id, { ...c }])));
    setFresh(blank(list.length > 0 ? Math.max(...list.map((c) => c.sort)) + 10 : 0));
  };
  useEffect(() => {
    load().catch((e: Error) => setMessage(e.message));
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack" style={{ gap: "0.6rem", width: "100%" }}>
      <h2 style={{ margin: 0, fontSize: "1rem" }}>{t("Caster copypastas", "Copypastas des commentateurs")}</h2>
      <p className="muted" style={{ margin: 0, fontSize: "0.76rem" }}>
        {t(
          "The caster desk's Copypastas list. A caster's Show puts one over the board, said by the barnacle you pick. Lowest order first. A desk already open sees changes when its caster presses Refresh.",
          "La liste Copypastas du poste des commentateurs. Afficher en met un par-dessus le plateau, dit par le bernacle choisi. Ordre le plus bas en premier. Un poste déjà ouvert voit les changements quand son commentateur appuie sur Actualiser."
        )}
      </p>
      {message && <span className="error-text">{message}</span>}

      <CopypastaForm draft={fresh} busy={busy} onChange={setFresh} onSave={() => void run(() => saveCopypasta(fresh))} />

      {rows === null ? (
        <span className="muted">{t("Loading...", "Chargement...")}</span>
      ) : (
        rows.map((c) => (
          <CopypastaForm
            key={c.id}
            draft={drafts[c.id] ?? c}
            busy={busy}
            onChange={(d) => setDrafts((all) => ({ ...all, [c.id]: d }))}
            onSave={() => void run(() => saveCopypasta(drafts[c.id] ?? c))}
            onDelete={() => {
              if (window.confirm(t(`Delete "${c.title}"?`, `Supprimer « ${c.title} » ?`))) void run(() => deleteCopypasta(c.id));
            }}
          />
        ))
      )}
    </div>
  );
}
