import type { AdminTeamRow } from "../../lib/tournament/api";
import { useT } from "../../lib/language";

interface Props {
  /** The teams in seed order, best first. */
  teams: AdminTeamRow[];
  onChange: (teams: AdminTeamRow[]) => void;
  /** The order the teams signed up in, for "reset". */
  signupOrder: AdminTeamRow[];
}

/**
 * The seed order, which is the one thing that decides who meets whom: in a knockout the top seed meets
 * the bottom seed first, in Swiss the first round pairs the top half against the bottom half, and in
 * groups the seeds are dealt out so no group is stacked.
 *
 * Starts in sign-up order, which favours nobody. The administrator can move teams up and down, or
 * shuffle for a random draw. A shuffle uses the browser's cryptographic randomness, so a draw cannot be
 * predicted from an earlier one.
 */
export function SeedList({ teams, onChange, signupOrder }: Props) {
  const t = useT();

  function move(from: number, to: number) {
    if (to < 0 || to >= teams.length) return;
    const next = [...teams];
    const [team] = next.splice(from, 1);
    next.splice(to, 0, team);
    onChange(next);
  }

  function shuffle() {
    const next = [...teams];
    // Fisher-Yates with unbiased integers from crypto - a plain Math.random() % n would slightly favour
    // some positions, and a draw is exactly where nobody should be able to say it was.
    for (let i = next.length - 1; i > 0; i--) {
      const limit = 0x100000000 - (0x100000000 % (i + 1));
      let r: number;
      do {
        r = crypto.getRandomValues(new Uint32Array(1))[0];
      } while (r >= limit);
      const j = r % (i + 1);
      [next[i], next[j]] = [next[j], next[i]];
    }
    onChange(next);
  }

  return (
    <div className="stack" style={{ gap: "0.5rem" }}>
      <div className="row">
        <button onClick={shuffle}>{t("Shuffle (random draw)", "Mélanger (tirage au sort)")}</button>
        <button onClick={() => onChange([...signupOrder])}>{t("Sign-up order", "Ordre d'inscription")}</button>
      </div>
      <div className="t-list">
        {teams.map((team, index) => (
          <div className="t-item" key={team.id}>
            <span>
              <strong style={{ display: "inline-block", minWidth: "2.2ch", color: "var(--accent-bright)" }}>{index + 1}</strong>{" "}
              {team.name}{" "}
              <span className="muted" style={{ fontSize: "0.78rem" }}>{team.roster.map((m) => m.display_name).join(", ")}</span>
            </span>
            <span className="row" style={{ gap: "0.25rem" }}>
              <button
                style={{ padding: "0.15rem 0.55rem" }}
                disabled={index === 0}
                onClick={() => move(index, index - 1)}
                aria-label={t(`Move ${team.name} up`, `Monter ${team.name}`)}
              >
                ▲
              </button>
              <button
                style={{ padding: "0.15rem 0.55rem" }}
                disabled={index === teams.length - 1}
                onClick={() => move(index, index + 1)}
                aria-label={t(`Move ${team.name} down`, `Descendre ${team.name}`)}
              >
                ▼
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
