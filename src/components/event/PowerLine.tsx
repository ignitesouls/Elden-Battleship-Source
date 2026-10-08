import type { TeamPowerInfo } from "../../hooks/useTeamPowers";
import { matchLine, moneyline } from "../../lib/tournament/teamPower";
import { useT } from "../../lib/language";

/**
 * Team power and match lines, as the tournament pages show them - always with an asterisk, and every
 * page that shows one carries <JustForFun /> at the bottom to say what the asterisk means.
 *
 * The numbers come from lib/tournament/teamPower (fitted against the archive by
 * scripts/calibrate-team-power.ts); this file only decides how they read.
 */

/** A team's power, e.g. "1563*". Nothing when it isn't known. */
export function PowerTag({ info, style }: { info: TeamPowerInfo | undefined; style?: React.CSSProperties }) {
  const t = useT();
  if (!info) return null;
  const unrated = info.rated === 0;
  return (
    <span
      className="power-tag"
      style={style}
      title={
        unrated
          ? t("No one on this team has played a counted game yet, so it is rated as an average side.", "Personne dans cette équipe n'a encore joué de partie comptée : elle est notée comme une équipe moyenne.")
          : t(
              `Team power: the average of its players', from their results and battle ratings on the leaderboards. ${info.rated} of ${info.size} have a record. 1500 is an average side; 200 points is roughly 3 to 1. Just for fun.`,
              `Puissance d'équipe : la moyenne de celles de ses joueurs, d'après leurs résultats et leurs notes de combat. ${info.rated} sur ${info.size} ont un historique. 1500 = équipe moyenne ; 200 points ≈ 3 contre 1. Juste pour le plaisir.`,
            )
      }
    >
      {t("Power", "Puissance")} {Math.round(info.power)}
      {unrated && "?"}*
    </span>
  );
}

/**
 * The line on a match between A and B: moneylines, each side's chance, and in a best-of-3 or longer the
 * series handicap. `compact` is the bracket card's single short row.
 *
 * Nothing when either side's power is unknown, or when neither side has any record at all - a line of
 * EVEN / EVEN between two unknowns would look like a prediction and be none.
 */
export function MatchOdds({
  a,
  b,
  nameA,
  nameB,
  bestOf,
  compact = false,
}: {
  a: TeamPowerInfo | undefined;
  b: TeamPowerInfo | undefined;
  nameA: string;
  nameB: string;
  bestOf: number;
  compact?: boolean;
}) {
  const t = useT();
  if (!a || !b || (a.rated === 0 && b.rated === 0)) return null;
  const line = matchLine(a.power, b.power, bestOf);
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  const hc = line.handicap;
  const hcText = hc ? `${hc.favourite === "a" ? nameA : nameB} -${hc.games} (${moneyline(hc.cover)})` : null;
  const title = t(
    `${nameA} ${line.a} (${pct(line.pA)}) · ${nameB} ${line.b} (${pct(1 - line.pA)})${hcText ? ` · series handicap: ${hcText}` : ""}. From the teams' power. Just for fun - no real betting.`,
    `${nameA} ${line.a} (${pct(line.pA)}) · ${nameB} ${line.b} (${pct(1 - line.pA)})${hcText ? ` · handicap de série : ${hcText}` : ""}. D'après la puissance des équipes. Juste pour le plaisir - aucun pari réel.`,
  );

  if (compact) {
    return (
      <div className="match-odds match-odds--compact" title={title}>
        <span>{line.a}</span>
        <span className="muted">{pct(line.pA)} · {pct(1 - line.pA)}*</span>
        <span>{line.b}</span>
      </div>
    );
  }
  return (
    <div className="match-odds" title={title}>
      <span>
        {nameA} <strong>{line.a}</strong>
      </span>
      <span className="muted">·</span>
      <span>
        {nameB} <strong>{line.b}</strong>
      </span>
      <span className="muted">
        ({pct(line.pA)} / {pct(1 - line.pA)})
      </span>
      {hcText && (
        <>
          <span className="muted">·</span>
          <span>{hcText}</span>
        </>
      )}
      <span className="muted">*</span>
    </div>
  );
}

/** What the asterisk means. At the bottom of every page that shows a power or a line. */
export function JustForFun() {
  const t = useT();
  return (
    <p className="muted just-for-fun">
      *{" "}
      {t(
        "Elden Battleship is not about real gambling - team power and the lines are just for fun, worked out from the leaderboards. No bets are taken and nothing is won.",
        "Elden Battleship n'a rien à voir avec les vrais paris - la puissance des équipes et les cotes sont juste pour le plaisir, calculées d'après les classements. Aucun pari n'est pris et rien n'est gagné.",
      )}
    </p>
  );
}
