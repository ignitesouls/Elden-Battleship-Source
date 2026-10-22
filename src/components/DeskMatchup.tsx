import { useEffect, useState } from "react";
import { useDeskPublisher } from "../lib/deskLink";
import { useT } from "../lib/language";

/** The matchup, kept in this browser between shows like the caster names. Best-effort either way. */
const MATCHUP_KEY = "eb_starting_soon_matchup";
/** The official match whose two teams were last filled in, so a reload doesn't undo a caster's edit. */
const FILLED_KEY = "eb_starting_soon_match";

/** An official match's two team names, offered to the Starting Soon screen. */
export interface DeskTeams {
  match: string;
  names: [string, string];
}

function readMatchup(): [string, string] {
  try {
    const raw = JSON.parse(localStorage.getItem(MATCHUP_KEY) ?? "[]");
    return Array.isArray(raw) ? [String(raw[0] ?? ""), String(raw[1] ?? "")] : ["", ""];
  } catch {
    return ["", ""];
  }
}

function remember(next: [string, string]): void {
  try {
    localStorage.setItem(MATCHUP_KEY, JSON.stringify(next));
  } catch {
    /* just won't be remembered next time */
  }
}

/**
 * The "Starting Soon: A vs. B" names, on the caster desk.
 *
 * Its own component because the desk shows it in two places: inside the full desk once the caster is
 * in a room, and alone on the "you're not in a room yet" page - which is exactly when a Starting Soon
 * screen is up. It talks to the Starting Soon source over lib/deskLink, keyed on the stream's owner,
 * so a room is never needed.
 *
 * `userId` is that owner - the caster's own account, or the desk they joined as a co-caster. Only
 * their own desk's matchup is remembered in this browser; on somebody else's they are editing that
 * stream's names, which are not theirs to bring home. Mount it keyed on the owner, so switching desks
 * starts clean.
 *
 * `teams` is the official match the desk is casting, when it knows one: its two team names go up by
 * themselves, so a caster who opened the lobby from the desk has nothing to type. Once per match, and
 * only on the owner's desk - after that the fields are the caster's again.
 */
export function DeskMatchup({
  userId,
  own = true,
  teams = null,
}: {
  userId: string | null | undefined;
  own?: boolean;
  teams?: DeskTeams | null;
}) {
  const t = useT();
  const [matchup, setMatchup] = useState<[string, string]>(() => (own ? readMatchup() : ["", ""]));
  useDeskPublisher(userId, { matchup }, (s) => setMatchup([s.matchup?.[0] ?? "", s.matchup?.[1] ?? ""]), own);

  const teamsMatch = teams?.match ?? null;
  const teamA = teams?.names[0] ?? "";
  const teamB = teams?.names[1] ?? "";
  useEffect(() => {
    if (!own || !teamsMatch) return;
    try {
      if (localStorage.getItem(FILLED_KEY) === teamsMatch) return;
      localStorage.setItem(FILLED_KEY, teamsMatch);
    } catch {
      /* fill it anyway - a reload may fill it again, which is the lesser problem */
    }
    setMatchup([teamA, teamB]);
    remember([teamA, teamB]);
  }, [own, teamsMatch, teamA, teamB]);

  const edit = (i: 0 | 1, value: string) => {
    const next: [string, string] = [...matchup];
    next[i] = value;
    setMatchup(next);
    if (own) remember(next);
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
