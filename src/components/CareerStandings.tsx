import { useMemo } from "react";
import { Link } from "react-router-dom";
import { profileName, type Profile } from "../lib/profiles";
import type { CareerStats } from "../lib/careerStats";
import { paceLabel, MIN_GAPS_FOR_PACE } from "../lib/squarePace";
import { SortHeader, useSortColumns, type SortColumn } from "./SortHeader";
import type { RatedPlayer } from "../hooks/useRatedPlayers";
import { useT } from "../lib/language";

type SortKey = "name" | "wins" | "winRate" | "elo" | "battle" | "shots" | "hits" | "sunk" | "accuracy" | "pace";

/**
 * Which standings a table is showing.
 *
 * "board" is the ordinary leaderboard - every finished match on one square set. "official" is every
 * official tournament match, on whatever board each was played; "event" is the official matches of one
 * tournament. The two tournament tables have no Elo column: Elo is an all-time number built from every
 * game, so in a table that is otherwise tournament-only it would be the one figure that isn't.
 */
export type StandingsScope = "board" | "official" | "event";

/** Columns that can be blank. A blank sits at the bottom in both directions rather than sorting as zero. */
const NULLABLE: Partial<Record<SortKey, (r: StandingsRow) => number | null>> = {
  pace: (r) => r.pace,
  elo: (r) => r.elo,
  battle: (r) => r.battle,
};

/** A career row with the things the table needs that aggregation doesn't carry. */
export interface StandingsRow extends CareerStats {
  /** Median seconds per square, or null when they haven't enough squares to have a pace yet. */
  pace: number | null;
  /** The name as SHOWN, so sorting by captain matches what the reader is looking at. */
  displayName: string;
  /** All-time Elo across every board, or null with no two-fleet game (or while loading). */
  elo: number | null;
  /** All-time battle rating across every board, or null with no rated game (or while loading). */
  battle: number | null;
}

/** Joins the pace, shown name and all-time ratings onto aggregated careers. */
export function toStandingsRows(
  careers: CareerStats[],
  paces: Map<string, number>,
  profiles: Map<string, Profile>,
  rated: Map<string, RatedPlayer> | null
): StandingsRow[] {
  return careers.map((c) => {
    const r = rated?.get(c.key);
    return {
      ...c,
      pace: paces.get(c.key) ?? null,
      displayName: profileName(c.userId ? profiles.get(c.userId) : undefined) ?? c.nickname,
      // An Elo with no games behind it is just the 1500 starting point, not a rating.
      elo: r && r.games > 0 ? r.elo : null,
      battle: r?.battle ?? null,
    };
  });
}

/**
 * Every column carries a `title`, including the ones whose heading looks self-explanatory.
 *
 * "Hits" and "Sunk" read as obvious until you ask whether a hit that sinks a ship counts once or
 * twice, or whether "shots" means squares taken or trigger-pulls. The headings can't answer that in
 * four characters and the answers are not guessable, so the explanation lives one hover away rather
 * than nowhere. Consistency is deliberate too: a tooltip on some headings and not others teaches
 * people that hovering usually does nothing.
 *
 * Built inside the component so every label and tooltip can go through `t()`.
 */
function buildColumns(t: (en: string, fr: string) => string, scope: StandingsScope): SortColumn<SortKey>[] {
  const official = scope !== "board";
  const event = scope === "event";
  const columns: SortColumn<SortKey>[] = [
    {
      key: "name",
      label: t("Captain", "Capitaine"),
      align: "left",
      firstDirection: "asc",
      title: official
        ? t(
            "Signed-in captains are grouped by account; guests by nickname, so two guests sharing a name share a row. Click a name for their full record.",
            "Les capitaines connectés sont regroupés par compte ; les invités par pseudo, donc deux invités partageant un nom partagent une ligne. Cliquez sur un nom pour son historique complet."
          )
        : t(
            "Signed-in captains are grouped by account; guests by nickname, so two guests sharing a name share a row. Click a name for their full record on this board.",
            "Les capitaines connectés sont regroupés par compte ; les invités par pseudo, donc deux invités partageant un nom partagent une ligne. Cliquez sur un nom pour son historique complet sur ce plateau."
          ),
    },
    {
      key: "wins",
      label: t("W-L", "V-D"),
      align: "right",
      firstDirection: "desc",
      title: event
        ? t(
            "Wins and losses across every official match of this tournament. Draws are recorded but not shown.",
            "Victoires et défaites sur tous les matchs officiels de ce tournoi. Les matchs nuls sont enregistrés mais non affichés."
          )
        : official
        ? t(
            "Wins and losses across every official tournament match. Draws are recorded but not shown.",
            "Victoires et défaites sur tous les matchs officiels de tournoi. Les matchs nuls sont enregistrés mais non affichés."
          )
        : t(
            "Wins and losses across every finished match on this board. Draws are recorded but not shown.",
            "Victoires et défaites sur toutes les parties terminées de ce plateau. Les matchs nuls sont enregistrés mais non affichés."
          ),
    },
    {
      key: "winRate",
      label: t("Win %", "% Victoires"),
      align: "right",
      firstDirection: "desc",
      title: t(
        "Share of finished matches won. Sorting by this falls back to total wins.",
        "Part des parties terminées gagnées. Le tri par cette colonne se rabat sur le total de victoires."
      ),
    },
    {
      key: "elo",
      label: "Elo",
      align: "right",
      firstDirection: "desc",
      title: t(
        "All time, across every board - not just this one. Everyone starts at 1500; every two-fleet game moves it, and beating a stronger crew gains more than beating a weaker one. A crew wins or loses together. 1v1s count; practice never does. Blank with no two-fleet game yet.",
        "Depuis toujours, sur tous les plateaux - pas seulement celui-ci. Tout le monde commence à 1500 ; chaque partie à deux flottes le fait bouger, et battre un équipage plus fort rapporte plus qu'en battre un plus faible. Un équipage gagne ou perd ensemble. Les 1v1 comptent ; l'entraînement jamais. Vide sans partie à deux flottes."
      ),
    },
    {
      key: "battle",
      label: t("Battle", "Combat"),
      align: "right",
      firstDirection: "desc",
      title: official
        ? t(
            "All time, across every game - not just official ones. The Hall of Fame battle rating (0-100), averaged over every rated game - how a captain plays: squares taken, hard squares, sinks. Pulled slightly towards 50 so one great night isn't a great player. 1v1s and practice never count.",
            "Depuis toujours, sur toutes les parties - pas seulement les officielles. La note de combat du Panthéon (0-100), en moyenne sur toutes les parties notées - la façon dont un capitaine joue : cases prises, cases difficiles, navires coulés. Légèrement ramenée vers 50 pour qu'une grande soirée ne fasse pas un grand joueur. Les 1v1 et l'entraînement ne comptent jamais."
          )
        : t(
            "All time, across every board - not just this one. The Hall of Fame battle rating (0-100), averaged over every rated game - how a captain plays: squares taken, hard squares, sinks. Pulled slightly towards 50 so one great night isn't a great player. 1v1s and practice never count.",
            "Depuis toujours, sur tous les plateaux - pas seulement celui-ci. La note de combat du Panthéon (0-100), en moyenne sur toutes les parties notées - la façon dont un capitaine joue : cases prises, cases difficiles, navires coulés. Légèrement ramenée vers 50 pour qu'une grande soirée ne fasse pas un grand joueur. Les 1v1 et l'entraînement ne comptent jamais."
          ),
    },
    {
      key: "shots",
      label: t("Shots", "Tirs"),
      align: "right",
      firstDirection: "desc",
      title: t(
        "Squares taken. Each square counts once, hit or miss, however many fleets it went out at.",
        "Cases prises. Chaque case compte une fois, touché ou manqué, quel que soit le nombre de flottes visées."
      ),
    },
    {
      key: "hits",
      label: t("Hits", "Touchés"),
      align: "right",
      firstDirection: "desc",
      title: t(
        "Shots that landed on an enemy ship. A shot that lands on more than one fleet counts once.",
        "Tirs ayant touché un navire ennemi. Un tir touchant plusieurs flottes ne compte qu'une fois."
      ),
    },
    {
      key: "sunk",
      label: t("Sunk", "Coulés"),
      align: "right",
      firstDirection: "desc",
      title: t(
        "Enemy ships finished off. The sinking shot counts as a hit as well.",
        "Navires ennemis achevés. Le tir qui coule compte aussi comme un touché."
      ),
    },
    {
      key: "accuracy",
      label: t("Acc.", "Préc."),
      align: "right",
      firstDirection: "desc",
      title: event
        ? t(
            "Accuracy - hits as a share of shots fired, over every official match of this tournament.",
            "Précision - part des tirs qui touchent, sur tous les matchs officiels de ce tournoi."
          )
        : official
        ? t(
            "Accuracy - hits as a share of shots fired, over every official match.",
            "Précision - part des tirs qui touchent, sur tous les matchs officiels."
          )
        : t(
            "Accuracy - hits as a share of shots fired, over this whole board.",
            "Précision - part des tirs qui touchent, sur l'ensemble de ce plateau."
          ),
    },
    {
      key: "pace",
      label: t("pace", "rythme"),
      sublabel: t("median", "médian"),
      align: "right",
      firstDirection: "asc",
      title: event
        ? t(
            `Square pace - the time from one square falling to the next, as a median across every square they have fired in this tournament's official matches. Needs ${MIN_GAPS_FOR_PACE} squares before it shows.`,
            `Rythme - le temps entre la chute d'une case et la suivante, en médiane sur toutes les cases visées dans les matchs officiels de ce tournoi. Nécessite ${MIN_GAPS_FOR_PACE} cases avant de s'afficher.`
          )
        : official
        ? t(
            `Square pace - the time from one square falling to the next, as a median across every square they have fired in official matches. Needs ${MIN_GAPS_FOR_PACE} squares before it shows.`,
            `Rythme - le temps entre la chute d'une case et la suivante, en médiane sur toutes les cases visées en matchs officiels. Nécessite ${MIN_GAPS_FOR_PACE} cases avant de s'afficher.`
          )
        : t(
            `Square pace - the time from one square falling to the next, as a median across every square they have fired on this board. Needs ${MIN_GAPS_FOR_PACE} squares before it shows. Only counts squares marked after 9/20, when auto-mark became a prerequisite for speed records.`,
            `Rythme - le temps entre la chute d'une case et la suivante, en médiane sur toutes les cases visées sur ce plateau. Nécessite ${MIN_GAPS_FOR_PACE} cases avant de s'afficher. Ne compte que les cases marquées après le 20/09, date à laquelle le marquage automatique est devenu obligatoire pour les records de vitesse.`
          ),
    },
  ];
  return official ? columns.filter((c) => c.key !== "elo") : columns;
}

/**
 * Ascending comparison for one column. The caller flips it for descending.
 *
 * The secondary keys are not decoration. Sorting on a rate alone puts whoever has the smallest
 * sample on top, so every rate falls back to the volume behind it and every count falls back to the
 * rate - which keeps a captain with 9 hits from outranking one with 9 hits at twice the accuracy.
 */
function compare(a: StandingsRow, b: StandingsRow, key: SortKey): number {
  switch (key) {
    case "name":
      return a.displayName.localeCompare(b.displayName);
    case "wins":
      return a.wins - b.wins || a.winRate - b.winRate;
    case "winRate":
      return a.winRate - b.winRate || a.wins - b.wins;
    // Nulls for these and pace are handled before this is reached - see the sort below.
    case "elo":
      return (a.elo ?? 0) - (b.elo ?? 0) || a.wins - b.wins;
    case "battle":
      return (a.battle ?? 0) - (b.battle ?? 0) || (a.elo ?? 0) - (b.elo ?? 0);
    case "shots":
      return a.shots - b.shots || a.hits - b.hits;
    case "hits":
      return a.hits - b.hits || a.accuracy - b.accuracy;
    case "sunk":
      return a.sunk - b.sunk || a.hits - b.hits;
    case "accuracy":
      return a.accuracy - b.accuracy || a.hits - b.hits;
    case "pace":
      return (a.pace ?? 0) - (b.pace ?? 0) || b.shots - a.shots;
  }
}

/**
 * The sortable career standings table, shared by the leaderboard and the Official record so the two
 * read identically - same columns, same tooltips, same tie-breaks - apart from what the scope drops.
 */
export function CareerStandings({
  careers,
  profiles,
  scope,
  linkSet,
  ratingsLoading,
  paceLoading,
}: {
  careers: StandingsRow[];
  profiles: Map<string, Profile>;
  scope: StandingsScope;
  /** Carried onto the player link, so a captain's page opens on the board the row was counted on. */
  linkSet?: string;
  /** The all-time ratings request is still out - blank ratings read "..." rather than "-". */
  ratingsLoading: boolean;
  /** The shot log is still out - blank paces read "..." rather than "-". */
  paceLoading: boolean;
}) {
  const t = useT();
  const columns = buildColumns(t, scope);
  const showElo = scope === "board";
  const { sort, direction, sortBy } = useSortColumns(columns, "wins");

  const sorted = useMemo(
    () =>
      [...careers].sort((a, b) => {
        // A captain without a pace (or rating) yet sits at the bottom in BOTH directions rather than
        // sorting as zero, which would otherwise read as infinitely fast - or infinitely bad.
        const pick = NULLABLE[sort];
        if (pick && (pick(a) === null || pick(b) === null)) {
          if (pick(a) === null && pick(b) === null) return b.shots - a.shots;
          return pick(a) === null ? 1 : -1;
        }
        const cmp = compare(a, b, sort);
        return direction === "asc" ? cmp : -cmp;
      }),
    [careers, sort, direction]
  );

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
        {/* Not sticky: this table scrolls with the PAGE rather than inside a box, and a
            header pinned to the viewport would float over whatever sits above it. */}
        <SortHeader columns={columns} sort={sort} direction={direction} onSort={sortBy} leading="#" sticky={false} />
        <tbody>
          {sorted.map((c, i) => {
            const p = c.userId ? profiles.get(c.userId) : undefined;
            const num = { padding: "0.25rem 0.4rem", fontVariantNumeric: "tabular-nums" as const };
            const link = `/player/${encodeURIComponent(c.key)}${linkSet ? `?set=${encodeURIComponent(linkSet)}` : ""}`;
            return (
              <tr key={c.key} style={{ textAlign: "right", borderTop: "1px solid var(--panel-border)" }}>
                <td style={{ textAlign: "left", padding: "0.25rem 0.4rem", color: "var(--text-dim)" }}>{i + 1}</td>
                <td style={{ textAlign: "left", padding: "0.25rem 0.4rem" }}>
                  <Link
                    to={link}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      textDecoration: "none",
                      color: "var(--text)",
                    }}
                  >
                    {p?.avatar_url && <img src={p.avatar_url} alt="" width={20} height={20} style={{ borderRadius: "50%" }} />}
                    <span>{c.displayName}</span>
                    {!c.verified && (
                      <span className="badge" title={t("Not signed in - grouped by nickname only", "Non connecté - regroupé par pseudo uniquement")}>
                        {t("guest", "invité")}
                      </span>
                    )}
                  </Link>
                </td>
                {/* Wins and losses only. Draws are archived but never shown here: they need
                    a match to end with no winner at all, which has happened zero times, and a
                    third number that is always 0 is a column of noise. */}
                <td style={num}>
                  {c.wins}-{c.losses}
                </td>
                <td style={num}>{Math.round(c.winRate * 100)}%</td>
                {/* Same "still reading" vs "none yet" split as pace below. */}
                {showElo && (
                  <td style={{ ...num, color: c.elo === null ? "var(--text-dim)" : undefined }}>
                    {c.elo !== null ? Math.round(c.elo) : ratingsLoading ? "..." : "-"}
                  </td>
                )}
                <td style={{ ...num, color: c.battle === null ? "var(--text-dim)" : undefined }}>
                  {c.battle !== null ? Math.round(c.battle) : ratingsLoading ? "..." : "-"}
                </td>
                <td style={num}>{c.shots}</td>
                <td style={{ ...num, color: "var(--hit)" }}>{c.hits}</td>
                <td style={{ ...num, color: "var(--sunk)" }}>{c.sunk}</td>
                <td style={num}>{Math.round(c.accuracy * 100)}%</td>
                {/* Pace rides on the shot log, which lands after the table has already drawn,
                    so an empty cell means "still reading" for the first moment and "not
                    enough squares yet" after that. They read differently on purpose. */}
                <td style={{ ...num, color: c.pace === null ? "var(--text-dim)" : undefined }}>
                  {c.pace !== null ? paceLabel(c.pace) : paceLoading ? "..." : "-"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
