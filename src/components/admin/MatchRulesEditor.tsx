import { COUNTDOWNS, PREP_MINUTES, minBoardFor, rulesProblem, withSquareSet, type MatchRules } from "../../lib/tournament/matchRules";
import { SQUARE_SET_LIST, squarePool, squareSet, squareSetCaps, squareSetVariants } from "../../lib/squareSets";
import { BOARD_SIZES, CUSTOM_HULLS, customFleet, customFleetFits, fleetCounts, fleetFor } from "../../types/battleship";
import { useT } from "../../lib/language";

/** Every set's ceiling, once - what the rules are checked and saved against. */
export const SET_CAPS = squareSetCaps();

const LARGEST = BOARD_SIZES[BOARD_SIZES.length - 1];

/**
 * Every set a room can be put on, cuts included, as the lobby's two rows (set, then cut) folded into
 * one list - "Bosses - All bosses", "Bosses - Small crew", then the sets that have no cuts.
 */
const SET_CHOICES = SQUARE_SET_LIST.flatMap((parent) => {
  const cuts = squareSetVariants(parent.id).map((id) => squareSet(id)).filter((c) => c.cutLabel);
  const sets = cuts.length > 1 ? cuts : [parent];
  return sets.map((s) => ({ id: s.id, label: s.cutLabel && cuts.length > 1 ? `${parent.label} - ${s.cutLabel}` : parent.label, pool: squarePool(s) }));
});

/**
 * The rules an official match is played by: how long fleets have to place their ships, the countdown
 * before the first shot, and - each on its own - the square set, the board size and the fleet. An
 * official room takes these when it is linked and keeps them; the host cannot change them. Anything left
 * as the host's choice is whatever the host picked in the lobby.
 *
 * The menus only offer combinations that can be played (a size the squares can fill, a fleet that fits
 * the board); what is left over - say, a fixed fleet and a squares choice too small for it - is spelled
 * out underneath by rulesProblem, and the panels holding this editor will not save it.
 */
export function MatchRulesEditor({ rules, onChange }: { rules: MatchRules; onChange: (rules: MatchRules) => void }) {
  const t = useT();
  // A saved value the menus don't offer is kept as an extra entry rather than silently rewritten.
  const prepMinutes = Math.round(rules.prep_seconds / 60);
  const prepChoices = PREP_MINUTES.includes(prepMinutes) ? PREP_MINUTES : [...PREP_MINUTES, prepMinutes].sort((a, b) => a - b);
  const countChoices = COUNTDOWNS.includes(rules.starting_seconds) ? COUNTDOWNS : [...COUNTDOWNS, rules.starting_seconds].sort((a, b) => a - b);

  const setCap = rules.square_set ? (SET_CAPS[rules.square_set] ?? LARGEST) : LARGEST;
  const fleetMin = rules.fleet ? (minBoardFor(rules.fleet) ?? LARGEST) : BOARD_SIZES[0];
  const sizeChoices = BOARD_SIZES.filter((n) => n <= setCap && n >= fleetMin);
  // The board a fixed fleet has to fit: the fixed size, else the biggest the squares allow - a host can
  // always play on a smaller board, and a fleet that only fits a big one is refused there, not here.
  const fleetBoard = rules.board_size ?? setCap;
  const counts = rules.fleet ? fleetCounts(rules.fleet) : null;
  const fleetCells = rules.fleet ? rules.fleet.reduce((n, s) => n + s.size, 0) : 0;
  const problem = rulesProblem(rules, SET_CAPS);

  return (
    <div className="stack" style={{ gap: "0.5rem" }}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{t("Time to place ships", "Temps pour placer les navires")}</span>
          <select value={prepMinutes} onChange={(e) => onChange({ ...rules, prep_seconds: Number(e.target.value) * 60 })}>
            {prepChoices.map((m) => (
              <option key={m} value={m}>{t(`${m} min`, `${m} min`)}</option>
            ))}
          </select>
        </label>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{t("Countdown before the first shot", "Compte à rebours avant le premier tir")}</span>
          <select value={rules.starting_seconds} onChange={(e) => onChange({ ...rules, starting_seconds: Number(e.target.value) })}>
            {countChoices.map((s) => (
              <option key={s} value={s}>{t(`${s} s`, `${s} s`)}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{t("Squares", "Cases")}</span>
          <select value={rules.square_set ?? ""} onChange={(e) => onChange(withSquareSet(rules, e.target.value || null, SET_CAPS))}>
            <option value="">{t("Host's choice", "Au choix de l'hôte")}</option>
            {SET_CHOICES.map((c) => (
              <option key={c.id} value={c.id}>{`${c.label} (${c.pool})`}</option>
            ))}
            {/* A set this build no longer offers stays visible rather than the menu showing a blank. */}
            {rules.square_set && !SET_CHOICES.some((c) => c.id === rules.square_set) && (
              <option value={rules.square_set}>{rules.square_set}</option>
            )}
          </select>
        </label>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{t("Board size", "Taille du plateau")}</span>
          <select value={rules.board_size ?? ""} onChange={(e) => onChange({ ...rules, board_size: e.target.value ? Number(e.target.value) : null })}>
            <option value="">{t("Host's choice", "Au choix de l'hôte")}</option>
            {sizeChoices.map((n) => (
              <option key={n} value={n}>{`${n}x${n}`}</option>
            ))}
            {rules.board_size && !sizeChoices.includes(rules.board_size) && (
              <option value={rules.board_size}>{`${rules.board_size}x${rules.board_size}`}</option>
            )}
          </select>
        </label>
        <label className="stack" style={{ gap: "0.25rem" }}>
          <span className="muted">{t("Fleet", "Flotte")}</span>
          <select
            value={rules.fleet ? "fixed" : ""}
            onChange={(e) =>
              onChange({ ...rules, fleet: e.target.value ? fleetFor(Math.min(rules.board_size ?? 10, setCap)) : null })
            }
          >
            <option value="">{t("Host's choice", "Au choix de l'hôte")}</option>
            <option value="fixed">{t("Set by the event", "Fixée par l'événement")}</option>
          </select>
        </label>
      </div>

      {/* The fleet as a count per hull, like the lobby's custom fleet. + stops where the fleet would no
          longer fit the board it has to fit; - stops at the last ship. */}
      {rules.fleet && counts && (
        <div className="stack" style={{ gap: "0.3rem", maxWidth: "22rem" }}>
          {CUSTOM_HULLS.map((h) => {
            const n = counts[h.name];
            const more = customFleet({ ...counts, [h.name]: n + 1 });
            const less = customFleet({ ...counts, [h.name]: n - 1 });
            return (
              <div key={h.name} className="row" style={{ gap: "0.4rem", alignItems: "center" }}>
                <span style={{ fontSize: "0.8rem", flex: "1 1 auto" }}>{h.name} ({h.size})</span>
                <button
                  disabled={n === 0 || less.length === 0}
                  onClick={() => onChange({ ...rules, fleet: less })}
                  aria-label={`${t("One fewer", "Un de moins")} ${h.name}`}
                  style={{ minWidth: "2rem" }}
                >
                  −
                </button>
                <span style={{ minWidth: "1.5rem", textAlign: "center", fontSize: "0.85rem" }}>{n}</span>
                <button
                  disabled={!customFleetFits(more, fleetBoard)}
                  title={
                    customFleetFits(more, fleetBoard)
                      ? undefined
                      : t(
                          `A fleet can cover at most half of a ${fleetBoard}x${fleetBoard} board.`,
                          `Une flotte peut couvrir au plus la moitié d'un plateau ${fleetBoard}x${fleetBoard}.`,
                        )
                  }
                  onClick={() => onChange({ ...rules, fleet: more })}
                  aria-label={`${t("One more", "Un de plus")} ${h.name}`}
                  style={{ minWidth: "2rem" }}
                >
                  +
                </button>
              </div>
            );
          })}
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            {t(
              `${rules.fleet.length} ships, ${fleetCells} squares - needs at least a ${fleetMin}x${fleetMin} board.`,
              `${rules.fleet.length} navires, ${fleetCells} cases - demande un plateau d'au moins ${fleetMin}x${fleetMin}.`,
            )}
          </span>
        </div>
      )}

      {problem ? (
        <span className="error-text" style={{ fontSize: "0.8rem" }}>{problem}</span>
      ) : (
        <span className="muted" style={{ fontSize: "0.75rem" }}>
          {t(
            "Anything left to the host is what they pick in the lobby. A host board too big for the event's squares is shrunk to fit, and the host's fleet is refit to the event's board size, the way the lobby does it. A room that can't meet the event's rules (a board too small for its fleet, squares too few for its board) is refused when it's made official, with the reason.",
            "Ce qui est laissé à l'hôte est ce qu'il choisit dans le salon. Un plateau trop grand pour les cases de l'événement est réduit, et la flotte de l'hôte est ajustée à la taille fixée, comme le fait le salon. Une partie qui ne peut pas respecter les règles (plateau trop petit pour la flotte, pas assez de cases pour le plateau) est refusée au moment de devenir officielle, avec la raison.",
          )}
        </span>
      )}
    </div>
  );
}
