import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { profileName, type Profile } from "../lib/profiles";
import { RATING_WEIGHTS, type BattleRating } from "../lib/battleRating";
import { useT } from "../lib/language";

interface Props {
  ratings: BattleRating[];
  profiles: Map<string, Profile>;
  /** Carried into the captain links, so a click lands on the same board's numbers. */
  setId: string;
  /** Narrow the list to one captain's battles, or null for everybody's. */
  captain: string | null;
  onCaptain: (key: string | null) => void;
  /** Admins only: strike the whole match this battle came from. Absent hides the button. */
  onVoid?: (battle: BattleRating) => void;
  /** Admins only: the match just voided, so the click can be taken back. */
  lastVoided?: { matchKey: string; label: string } | null;
  onUndoVoid?: () => void;
}

/** How many battles the list shows. The best of a board, not the whole archive. */
const SHOWN = 25;

const pct = (x: number) => Math.round(x * 100);

/**
 * The Hall of Fame: the best single battles on a board, by battle rating.
 *
 * One line per battle rather than per captain - the same captain can hold several places, because the
 * question is which GAMES were the best, and a captain's career is what their own page is for.
 */
export function HallOfFame({ ratings, profiles, setId, captain, onCaptain, onVoid, lastVoided, onUndoVoid }: Props) {
  const t = useT();
  const shown = (captain ? ratings.filter((r) => r.key === captain) : ratings).slice(0, SHOWN);

  // Everybody who has a rated battle, for the filter, named the way the rest of the page names them.
  const captains = new Map<string, string>();
  for (const r of ratings) {
    if (captains.has(r.key)) continue;
    const profile = r.userId ? profiles.get(r.userId) : undefined;
    captains.set(r.key, profileName(profile) ?? r.nickname);
  }
  const captainList = [...captains.entries()].sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <div className="panel stack" style={{ gap: "0.5rem" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>{t("Hall of Fame", "Panthéon")}</h3>
        <select
          value={captain ?? ""}
          onChange={(e) => onCaptain(e.target.value || null)}
          style={{ fontSize: "0.75rem", maxWidth: "14rem" }}
          aria-label={t("Captain", "Capitaine")}
        >
          <option value="">{t("Every captain", "Tous les capitaines")}</option>
          {captainList.map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <span className="muted" style={{ fontSize: "0.7rem" }}>
        {t(
          `The best single battles on this board, rated 0-100 against every other game on it. Squares taken, each weighted by how long its fight runs and how rarely it gets taken, per hour played (${pct(RATING_WEIGHTS.workload)}%); ships sunk (${pct(RATING_WEIGHTS.sunk)}%); hits (${pct(RATING_WEIGHTS.hits)}%); the win (${pct(RATING_WEIGHTS.win)}%); accuracy (${pct(RATING_WEIGHTS.accuracy)}%). Misses count as squares. Two-fleet crew games only: no 1v1s, nothing with three fleets or more.`,
          `Les meilleures batailles sur ce plateau, notées de 0 à 100 face à toutes les autres parties. Cases prises, chacune pondérée par la durée de son combat et sa rareté, par heure de jeu (${pct(RATING_WEIGHTS.workload)} %) ; navires coulés (${pct(RATING_WEIGHTS.sunk)} %) ; touchés (${pct(RATING_WEIGHTS.hits)} %) ; la victoire (${pct(RATING_WEIGHTS.win)} %) ; précision (${pct(RATING_WEIGHTS.accuracy)} %). Les tirs manqués comptent comme des cases. Parties à deux flottes avec équipages uniquement : pas de 1v1, rien à trois flottes ou plus.`
        )}
      </span>

      {lastVoided && onUndoVoid && (
        <div className="row" style={{ gap: "0.5rem", alignItems: "baseline", fontSize: "0.75rem" }}>
          <span className="muted" style={{ flex: 1, minWidth: 0 }}>
            {t(`Voided ${lastVoided.label}. It no longer counts anywhere.`, `${lastVoided.label} invalidée. Elle ne compte plus nulle part.`)}
          </span>
          <button onClick={onUndoVoid} style={{ fontSize: "0.7rem", padding: "0.15rem 0.45rem" }}>
            {t("Undo", "Annuler")}
          </button>
        </div>
      )}

      {shown.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          {t("No rated battles on this board yet.", "Aucune bataille notée sur ce plateau pour l'instant.")}
        </p>
      ) : (
        <div className="stack" style={{ gap: "0.5rem" }}>
          {shown.map((r, i) => (
            <BattleLine
              key={`${r.matchKey}|${r.key}`}
              rank={i + 1}
              battle={r}
              profiles={profiles}
              setId={setId}
              onVoid={onVoid ? () => onVoid(r) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One battle: rank, rating, captain, tags, then the numbers behind it. */
export function BattleLine({
  rank,
  battle: r,
  profiles,
  setId,
  onVoid,
}: {
  rank?: number;
  battle: BattleRating;
  profiles: Map<string, Profile>;
  setId: string;
  onVoid?: () => void;
}) {
  const t = useT();
  const profile = r.userId ? profiles.get(r.userId) : undefined;
  const result = r.draw ? t("Draw", "Nul") : r.won ? t("Won", "Victoire") : t("Lost", "Défaite");

  return (
    <div className="row" style={{ gap: "0.6rem", alignItems: "baseline" }}>
      {rank !== undefined && (
        <span className="muted" style={{ fontSize: "0.75rem", minWidth: "1.6rem", fontVariantNumeric: "tabular-nums" }}>
          {rank}.
        </span>
      )}
      <strong
        className="display"
        style={{ color: "var(--accent)", fontSize: "1.1rem", minWidth: "2rem", fontVariantNumeric: "tabular-nums" }}
      >
        {r.rating}
      </strong>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="row" style={{ gap: "0.4rem", alignItems: "baseline", flexWrap: "wrap" }}>
          <Link
            to={`/player/${encodeURIComponent(r.key)}?set=${encodeURIComponent(setId)}`}
            style={{ fontWeight: 600, fontSize: "0.88rem" }}
          >
            {profileName(profile) ?? r.nickname}
          </Link>
          {r.mvp && <Tag>{t("MVP", "MVP")}</Tag>}
          {r.role === "specialist" && <Tag>{t("Specialist", "Spécialiste")}</Tag>}
          {r.role === "offense" && <Tag>{t("Offense", "Attaque")}</Tag>}
        </span>
        <div className="muted" style={{ fontSize: "0.72rem" }}>
          {t(
            `${r.squares} squares (avg weight ${r.avgWeight.toFixed(1)}) · ${r.sunk} sunk · ${r.hits} hits · ${pct(r.accuracy)}% · ${result}`,
            `${r.squares} cases (poids moyen ${r.avgWeight.toFixed(1)}) · ${r.sunk} coulés · ${r.hits} touchés · ${pct(r.accuracy)} % · ${result}`
          )}
          {" · "}
          <Link to={`/match/${encodeURIComponent(r.matchKey)}`}>
            {new Date(r.finishedAt).toLocaleDateString([], { month: "short", day: "numeric" })}
          </Link>
        </div>
      </span>
      {onVoid && (
        <button
          className="danger"
          onClick={onVoid}
          title={t("Strike this whole match from every stat", "Retirer toute cette partie des statistiques")}
          style={{ fontSize: "0.65rem", padding: "0.1rem 0.4rem", flex: "none", alignSelf: "center" }}
        >
          {t("Void", "Invalider")}
        </button>
      )}
    </div>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span
      className="display"
      style={{
        fontSize: "0.6rem",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        padding: "0.1rem 0.35rem",
        borderRadius: 3,
        border: "1px solid var(--accent)",
        color: "var(--accent)",
      }}
    >
      {children}
    </span>
  );
}
