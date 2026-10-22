import { useState } from "react";
import { useDeskPublisher } from "../lib/deskLink";
import { useT } from "../lib/language";

/** The matchup, kept in this browser between shows like the caster names. Best-effort either way. */
const MATCHUP_KEY = "eb_starting_soon_matchup";

function readMatchup(): [string, string] {
  try {
    const raw = JSON.parse(localStorage.getItem(MATCHUP_KEY) ?? "[]");
    return Array.isArray(raw) ? [String(raw[0] ?? ""), String(raw[1] ?? "")] : ["", ""];
  } catch {
    return ["", ""];
  }
}

/**
 * The "Starting Soon: A vs. B" names, on the caster desk.
 *
 * Its own component because the desk shows it in two places: inside the full desk once the caster is
 * in a room, and alone on the "you're not in a room yet" page - which is exactly when a Starting Soon
 * screen is up. It talks to the Starting Soon source over lib/deskLink, keyed on the caster's account,
 * so a room is never needed.
 */
export function DeskMatchup({ userId }: { userId: string | null | undefined }) {
  const t = useT();
  const [matchup, setMatchup] = useState<[string, string]>(readMatchup);
  useDeskPublisher(userId, { matchup });

  const edit = (i: 0 | 1, value: string) => {
    const next: [string, string] = [...matchup];
    next[i] = value;
    setMatchup(next);
    try {
      localStorage.setItem(MATCHUP_KEY, JSON.stringify(next));
    } catch {
      /* just won't be remembered next time */
    }
  };

  return (
    <section>
      <h3>{t("Starting Soon", "Bientôt")}</h3>
      <div className="cast-row">
        <input
          type="text"
          maxLength={40}
          placeholder={t("First team", "Première équipe")}
          aria-label={t("First team", "Première équipe")}
          value={matchup[0]}
          onChange={(e) => edit(0, e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <span className="muted">vs.</span>
        <input
          type="text"
          maxLength={40}
          placeholder={t("Second team", "Deuxième équipe")}
          aria-label={t("Second team", "Deuxième équipe")}
          value={matchup[1]}
          onChange={(e) => edit(1, e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
      </div>
      <p className="cast-note muted">
        {t(
          "Shown on the EB Starting Soon scene. Works before you've joined a room. Leave both empty for just \"Starting Soon\".",
          "Affiché sur la scène EB Starting Soon. Fonctionne avant d'avoir rejoint une partie. Laissez les deux vides pour n'afficher que « Bientôt »."
        )}
      </p>
    </section>
  );
}
