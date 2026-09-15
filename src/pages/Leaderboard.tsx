import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchParticipants, fetchProfiles, fetchMatchEvents, profileName, type Profile } from "../lib/profiles";
import { SquareSetTabs } from "../components/SquareSetTabs";
import { rowSquareSet, busiestSquareSet, squareSet, DEFAULT_SQUARE_SET, type SquareSetId } from "../lib/challenges";
import { aggregateCareers, participantKey, type CareerStats, type ParticipantRow } from "../lib/careerStats";
import { buildRecordBook } from "../lib/recordBook";
import { squarePace, paceLabel, MIN_GAPS_FOR_PACE } from "../lib/squarePace";
import { RecordBook } from "../components/RecordBook";
import { LoadingScreen } from "../components/BrandMark";
import { SortHeader, useSortColumns, type SortColumn } from "../components/SortHeader";
import { useStoredToggle } from "../hooks/useStoredToggle";
import type { MatchEventRow } from "../lib/almanac";
import { SiteFooter } from "../components/SiteFooter";
import { useT } from "../lib/language";

type SortKey = "name" | "wins" | "winRate" | "shots" | "hits" | "sunk" | "accuracy" | "pace";

/**
 * How many matches a career needs before the "regulars only" filter keeps it.
 *
 * Five, because that is roughly where a rate stops describing one good night. A captain two matches
 * into their career can sit on a 100% win rate and the best accuracy on the board, and there is no
 * way to tell from the row whether that is a great player or a lucky Tuesday - which is exactly the
 * reading the filter exists to remove.
 */
const REGULAR_MATCHES = 5;

/** Remembered per browser, not per board: it is how somebody likes to read a table. */
const REGULARS_KEY = "eb_regulars_only";

/** A career row with the two things the table needs that aggregation doesn't carry. */
interface Row extends CareerStats {
  /** Median seconds per square, or null when they haven't enough squares to have a pace yet. */
  pace: number | null;
  /** The name as SHOWN, so sorting by captain matches what the reader is looking at. */
  displayName: string;
}

/**
 * Every column carries a `title`, including the ones whose heading looks self-explanatory.
 *
 * "Hits" and "Sunk" read as obvious until you ask whether a hit that sinks a ship counts once or
 * twice, or whether "shots" means squares taken or trigger-pulls. The headings can't answer that in
 * four characters and the answers are not guessable, so the explanation lives one hover away rather
 * than nowhere. Consistency is deliberate too: a tooltip on some headings and not others teaches
 * people that hovering usually does nothing.
 */
/** Built inside the component so every label and tooltip can go through `t()`. */
function buildColumns(t: (en: string, fr: string) => string): SortColumn<SortKey>[] {
  return [
    {
      key: "name",
      label: t("Captain", "Capitaine"),
      align: "left",
      firstDirection: "asc",
      title: t(
        "Signed-in captains are grouped by account; guests by nickname, so two guests sharing a name share a row. Click a name for their full record on this board.",
        "Les capitaines connectés sont regroupés par compte ; les invités par pseudo, donc deux invités partageant un nom partagent une ligne. Cliquez sur un nom pour son historique complet sur ce plateau."
      ),
    },
    {
      key: "wins",
      label: t("W-L", "V-D"),
      align: "right",
      firstDirection: "desc",
      title: t(
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
      title: t(
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
      title: t(
        `Square pace - the time from one square falling to the next, as a median across every square they have fired on this board. Needs ${MIN_GAPS_FOR_PACE} squares before it shows.`,
        `Rythme - le temps entre la chute d'une case et la suivante, en médiane sur toutes les cases visées sur ce plateau. Nécessite ${MIN_GAPS_FOR_PACE} cases avant de s'afficher.`
      ),
    },
  ];
}

/**
 * Ascending comparison for one column. The caller flips it for descending.
 *
 * The secondary keys are not decoration. Sorting on a rate alone puts whoever has the smallest
 * sample on top, so every rate falls back to the volume behind it and every count falls back to the
 * rate - which keeps a captain with 9 hits from outranking one with 9 hits at twice the accuracy.
 */
function compare(a: Row, b: Row, key: SortKey): number {
  switch (key) {
    case "name":
      return a.displayName.localeCompare(b.displayName);
    case "wins":
      return a.wins - b.wins || a.winRate - b.winRate;
    case "winRate":
      return a.winRate - b.winRate || a.wins - b.wins;
    case "shots":
      return a.shots - b.shots || a.hits - b.hits;
    case "hits":
      return a.hits - b.hits || a.accuracy - b.accuracy;
    case "sunk":
      return a.sunk - b.sunk || a.hits - b.hits;
    case "accuracy":
      return a.accuracy - b.accuracy || a.hits - b.hits;
    case "pace":
      // Nulls are handled before this is reached - see the sort below.
      return (a.pace ?? 0) - (b.pace ?? 0) || b.shots - a.shots;
  }
}

export function Leaderboard() {
  const t = useT();
  const COLUMNS = buildColumns(t);
  const [rows, setRows] = useState<ParticipantRow[] | null>(null);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const { sort, direction, sortBy } = useSortColumns(COLUMNS, "wins");

  /**
   * Archived shots, for the streak and timing records only.
   *
   * Fetched after the table has already rendered, because it is by far the biggest read on this page
   * and nothing above it needs to wait: the counting records come off the participation rows, so the
   * book appears with most of itself filled in and the rest arrives a moment later.
   */
  const [events, setEvents] = useState<MatchEventRow[] | null>(null);

  // Which board's records are on show. Null until the rows arrive, then whichever set has been
  // played most - opening on an empty table for a set nobody has touched helps nobody.
  const [setId, setSetId] = useState<SquareSetId | null>(null);

  /** Career totals, or one row per player per match - see GameTable. */
  const [view, setView] = useState<"career" | "game">("career");

  useEffect(() => {
    void (async () => {
      const data = await fetchParticipants();
      setRows(data);
      setSetId((current) => current ?? busiestSquareSet(data));
      setProfiles(await fetchProfiles(data.map((r) => r.user_id).filter(Boolean) as string[]));
      setEvents((await fetchMatchEvents()) as MatchEventRow[]);
    })();
  }, []);

  const shownSet = setId ?? DEFAULT_SQUARE_SET;

  /** Matches recorded per set, for the tab labels. Counted on matches, not participant rows. */
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    const seen = new Set<string>();
    for (const r of rows ?? []) {
      const key = `${rowSquareSet(r)}:${r.match_key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out[rowSquareSet(r)] = (out[rowSquareSet(r)] ?? 0) + 1;
    }
    return out;
  }, [rows]);

  /** Median seconds per square, per captain, for the board on show. */
  const paces = useMemo(
    () => squarePace((events ?? []).filter((e) => rowSquareSet(e) === shownSet)),
    [events, shownSet]
  );

  const careers = useMemo<Row[]>(() => {
    // Careers are aggregated per set, never across: an accuracy averaged over boss kills and
    // "acquire 3 painting rewards" describes neither board.
    const list = aggregateCareers((rows ?? []).filter((r) => rowSquareSet(r) === shownSet));
    return list.map((c) => ({
      ...c,
      pace: paces.get(c.key) ?? null,
      displayName: profileName(c.userId ? profiles.get(c.userId) : undefined) ?? c.nickname,
    }));
  }, [rows, shownSet, paces, profiles]);

  /**
   * "Regulars only" - hide careers thinner than REGULAR_MATCHES matches.
   *
   * Off by default, so the page opens showing everybody who has ever played: this is a lens for
   * reading the standings, not a bar for being in them, and somebody who has played twice should be
   * able to find themselves on the leaderboard the first time they look.
   *
   * Applied to the standings table ALONE, deliberately. The record book above it is untouched,
   * because a record is a single match rather than a career - the best game anybody has ever had is
   * still the best game if the person who had it never came back, and filtering it out would be
   * rewriting history rather than filtering a view.
   */
  const [regularsOnly, setRegularsOnly] = useStoredToggle(REGULARS_KEY, false);
  const thin = careers.length - careers.filter((c) => c.matches >= REGULAR_MATCHES).length;

  const sorted = useMemo(() => {
    const shown = regularsOnly ? careers.filter((c) => c.matches >= REGULAR_MATCHES) : careers;
    return [...shown].sort((a, b) => {
      // A captain without a pace yet sits at the bottom in BOTH directions rather than sorting as
      // zero, which would otherwise read as infinitely fast. Same for any column that can be blank.
      if (sort === "pace" && (a.pace === null || b.pace === null)) {
        if (a.pace === null && b.pace === null) return b.shots - a.shots;
        return a.pace === null ? 1 : -1;
      }
      const cmp = compare(a, b, sort);
      return direction === "asc" ? cmp : -cmp;
    });
  }, [careers, sort, direction, regularsOnly]);

  /**
   * The record book, for the same board the table is showing.
   *
   * Filtered to this set exactly as the careers are: a best-accuracy game on a board of boss kills and
   * one on a board of "acquire 3 painting rewards" are not the same record.
   */
  const records = useMemo(() => {
    const forSet = (rows ?? []).filter((r) => rowSquareSet(r) === shownSet);
    return buildRecordBook(forSet, (events ?? []).filter((e) => rowSquareSet(e) === shownSet), shownSet);
  }, [rows, events, shownSet]);

  if (rows === null) return <LoadingScreen>{t("Loading the records...", "Chargement des records...")}</LoadingScreen>;

  return (
    <div className="stack" style={{ width: "min(860px, 100%)" }}>
      <div style={{ textAlign: "center" }}>
        <h1>{t("Leaderboard", "Classement")}</h1>
        <p className="muted">{t("Career records for one board at a time.", "Records de carrière, un plateau à la fois.")}</p>
      </div>

      {/* Outside the empty check, so a set with no matches yet can still be switched away from. */}
      <div className="panel stack" style={{ gap: "0.4rem" }}>
        <SquareSetTabs value={shownSet} onChange={setSetId} counts={counts} />
        <span className="muted" style={{ fontSize: "0.72rem" }}>{squareSet(shownSet).blurb}</span>
        <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
          <button
            onClick={() => setView("career")}
            style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: view === "career" ? "var(--accent)" : undefined }}
          >
            {t("Career", "Carrière")}
          </button>
          <button
            onClick={() => setView("game")}
            style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: view === "game" ? "var(--accent)" : undefined }}
          >
            {t("Per Game", "Par partie")}
          </button>
        </div>
      </div>

      {careers.length === 0 ? (
        <div className="panel stack" style={{ alignItems: "center", textAlign: "center" }}>
          <p className="muted" style={{ margin: 0 }}>
            {t(
              `No finished matches on the ${squareSet(shownSet).label} board yet. Play one and the records start here.`,
              `Aucune partie terminée sur le plateau ${squareSet(shownSet).label} pour l'instant. Jouez-en une et les records commenceront ici.`
            )}
          </p>
          <Link to="/">{t("Back to the harbor", "Retour au port")}</Link>
        </div>
      ) : view === "game" ? (
        <GameTable rows={(rows ?? []).filter((r) => rowSquareSet(r) === shownSet)} profiles={profiles} />
      ) : (
        <>
        {/* Above the career table on purpose: "the best game anybody has had" is the thing people
            come back to read, and the standings are what they study once they're here. */}
        <RecordBook
          records={records}
          profiles={profiles}
          squareSet={shownSet}
          loadingShots={events === null}
        />

        <div className="panel stack" style={{ gap: "0.6rem" }}>
          {/* Above the table rather than beside the heading, so it reads as a control ON these rows.
              Hidden when it would do nothing: a board where everybody is a regular has nothing to
              filter, and a dead toggle is worse than no toggle. */}
          {thin > 0 && (
            <div className="row" style={{ justifyContent: "flex-end", gap: "0.5rem" }}>
              <button
                onClick={() => setRegularsOnly(!regularsOnly)}
                style={{ fontSize: "0.78rem", borderColor: regularsOnly ? "var(--accent)" : undefined }}
                aria-pressed={regularsOnly}
                title={t(
                  `Hides careers under ${REGULAR_MATCHES} matches. They stay on the leaderboard - this only changes what this table shows.`,
                  `Cache les carrières de moins de ${REGULAR_MATCHES} parties. Elles restent sur le classement - cela ne change que ce que ce tableau affiche.`
                )}
              >
                {regularsOnly
                  ? t(`Showing regulars only (${thin} hidden)`, `Habitués seulement (${thin} masqués)`)
                  : t(
                      `Showing everyone (${thin} under ${REGULAR_MATCHES} matches)`,
                      `Tout le monde (${thin} sous ${REGULAR_MATCHES} parties)`
                    )}
              </button>
            </div>
          )}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
              {/* Not sticky: this table scrolls with the PAGE rather than inside a box, and a
                  header pinned to the viewport would float over the record book above it. */}
              <SortHeader
                columns={COLUMNS}
                sort={sort}
                direction={direction}
                onSort={sortBy}
                leading="#"
                sticky={false}
              />
              <tbody>
                {sorted.map((c, i) => {
                  const p = c.userId ? profiles.get(c.userId) : undefined;
                  const num = { padding: "0.25rem 0.4rem", fontVariantNumeric: "tabular-nums" as const };
                  return (
                    <tr key={c.key} style={{ textAlign: "right", borderTop: "1px solid var(--panel-border)" }}>
                      <td style={{ textAlign: "left", padding: "0.25rem 0.4rem", color: "var(--text-dim)" }}>
                        {i + 1}
                      </td>
                      <td style={{ textAlign: "left", padding: "0.25rem 0.4rem" }}>
                        {/* Carries the set through, so a captain's page shows the same board's
                            numbers as the row that was clicked to reach it. */}
                        <Link
                          to={`/player/${encodeURIComponent(c.key)}?set=${encodeURIComponent(shownSet)}`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.4rem",
                            textDecoration: "none",
                            color: "var(--text)",
                          }}
                        >
                          {p?.avatar_url && (
                            <img src={p.avatar_url} alt="" width={20} height={20} style={{ borderRadius: "50%" }} />
                          )}
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
                      <td style={num}>{c.shots}</td>
                      <td style={{ ...num, color: "var(--hit)" }}>{c.hits}</td>
                      <td style={{ ...num, color: "var(--sunk)" }}>{c.sunk}</td>
                      <td style={num}>{Math.round(c.accuracy * 100)}%</td>
                      {/* Pace rides on the shot log, which lands after the table has already drawn,
                          so an empty cell means "still reading" for the first moment and "not
                          enough squares yet" after that. They read differently on purpose. */}
                      <td style={{ ...num, color: c.pace === null ? "var(--text-dim)" : undefined }}>
                        {c.pace !== null ? paceLabel(c.pace) : events === null ? "..." : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <span className="muted" style={{ fontSize: "0.7rem" }}>
            {t(
              "Click a heading to sort; click again to flip. Hover a heading for what the number means.",
              "Cliquez sur un en-tête pour trier ; cliquez à nouveau pour inverser. Survolez un en-tête pour voir ce que le nombre signifie."
            )}
          </span>
          <span className="muted" style={{ fontSize: "0.7rem" }}>
            {t("Sign in with Twitch for a record only you can add to.", "Connectez-vous avec Twitch pour un historique auquel vous seul pouvez ajouter.")}
          </span>
        </div>
        </>
      )}
      <SiteFooter />
    </div>
  );
}

type GameSortKey = "date" | "name" | "result" | "shots" | "hits" | "sunk" | "accuracy";

/** One participant row, ready for the flat per-game table. */
interface GameRow {
  key: string;
  matchKey: string;
  finishedAt: string;
  displayName: string;
  verified: boolean;
  won: boolean;
  draw: boolean;
  shots: number;
  hits: number;
  sunk: number;
  accuracy: number;
}

/** Built inside GameTable so every label and tooltip can go through `t()`. */
function buildGameColumns(t: (en: string, fr: string) => string): SortColumn<GameSortKey>[] {
  return [
    {
      key: "date",
      label: t("Date", "Date"),
      align: "left",
      firstDirection: "desc",
      title: t("When the match finished. Click a row to open its recap.", "Quand la partie s'est terminée. Cliquez sur une ligne pour ouvrir son résumé."),
    },
    {
      key: "name",
      label: t("Captain", "Capitaine"),
      align: "left",
      firstDirection: "asc",
      title: t("Signed-in captains are grouped by account; guests by nickname.", "Les capitaines connectés sont regroupés par compte ; les invités par pseudo."),
    },
    {
      key: "result",
      label: t("Result", "Résultat"),
      align: "right",
      firstDirection: "desc",
      title: t("Win, loss, or draw for that one match.", "Victoire, défaite ou match nul pour cette partie."),
    },
    {
      key: "shots",
      label: t("Shots", "Tirs"),
      align: "right",
      firstDirection: "desc",
      title: t("Squares taken in that match. Each square counts once, hit or miss.", "Cases prises dans cette partie. Chaque case compte une fois, touché ou manqué."),
    },
    {
      key: "hits",
      label: t("Hits", "Touchés"),
      align: "right",
      firstDirection: "desc",
      title: t("Shots that landed on an enemy ship, in that match.", "Tirs ayant touché un navire ennemi, dans cette partie."),
    },
    {
      key: "sunk",
      label: t("Sunk", "Coulés"),
      align: "right",
      firstDirection: "desc",
      title: t("Enemy ships finished off in that match.", "Navires ennemis achevés dans cette partie."),
    },
    {
      key: "accuracy",
      label: t("Acc.", "Préc."),
      align: "right",
      firstDirection: "desc",
      title: t("Hits as a share of shots, for that match alone.", "Part des tirs qui touchent, pour cette seule partie."),
    },
  ];
}

/** Win beats draw beats loss, so sorting by result groups the same way a standings column would. */
function resultRank(r: GameRow): number {
  if (r.draw) return 0.5;
  return r.won ? 1 : 0;
}

function compareGameRows(a: GameRow, b: GameRow, key: GameSortKey): number {
  switch (key) {
    case "date":
      return a.finishedAt.localeCompare(b.finishedAt);
    case "name":
      return a.displayName.localeCompare(b.displayName);
    case "result":
      return resultRank(a) - resultRank(b) || a.accuracy - b.accuracy;
    case "shots":
      return a.shots - b.shots || a.hits - b.hits;
    case "hits":
      return a.hits - b.hits || a.accuracy - b.accuracy;
    case "sunk":
      return a.sunk - b.sunk || a.hits - b.hits;
    case "accuracy":
      return a.accuracy - b.accuracy || a.hits - b.hits;
  }
}

/**
 * Every match, one row per player, instead of the career totals above.
 *
 * The career table answers "who's good overall" - this answers "what actually happened, game by
 * game", which the same rows can't show once they're summed. Built straight off the participation
 * rows already fetched for the career table, so it costs nothing extra to show.
 */
function GameTable({ rows, profiles }: { rows: ParticipantRow[]; profiles: Map<string, Profile> }) {
  const t = useT();
  const GAME_COLUMNS = buildGameColumns(t);
  const { sort, direction, sortBy } = useSortColumns(GAME_COLUMNS, "date");

  const gameRows = useMemo<GameRow[]>(
    () =>
      rows.map((r) => ({
        key: `${r.match_key}|${participantKey(r)}`,
        matchKey: r.match_key,
        finishedAt: r.finished_at,
        displayName: profileName(r.user_id ? profiles.get(r.user_id) : undefined) ?? r.nickname,
        verified: Boolean(r.user_id),
        won: r.won,
        draw: r.draw,
        shots: r.shots,
        hits: r.hits,
        sunk: r.sunk,
        accuracy: r.shots > 0 ? r.hits / r.shots : 0,
      })),
    [rows, profiles]
  );

  const sorted = useMemo(
    () => [...gameRows].sort((a, b) => (direction === "asc" ? 1 : -1) * compareGameRows(a, b, sort)),
    [gameRows, sort, direction]
  );

  if (gameRows.length === 0) return null;

  return (
    <div className="panel stack" style={{ gap: "0.6rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>{t("Every match", "Toutes les parties")}</h3>
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          {sorted.length} {sorted.length === 1 ? t("row", "ligne") : t("rows", "lignes")}
          {t(", one per captain per match.", ", une par capitaine par partie.")}
        </span>
      </div>
      <div style={{ overflowX: "auto", maxHeight: "34rem", overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
          <SortHeader columns={GAME_COLUMNS} sort={sort} direction={direction} onSort={sortBy} />
          <tbody>
            {sorted.map((r) => {
              const num = { padding: "0.25rem 0.4rem", fontVariantNumeric: "tabular-nums" as const };
              const when = new Date(r.finishedAt);
              return (
                <tr key={r.key} style={{ textAlign: "right", borderTop: "1px solid var(--panel-border)" }}>
                  <td style={{ textAlign: "left", padding: "0.25rem 0.4rem" }}>
                    <Link
                      to={`/match/${encodeURIComponent(r.matchKey)}`}
                      className="muted"
                      style={{ textDecoration: "none" }}
                    >
                      {when.toLocaleDateString()}
                    </Link>
                  </td>
                  <td style={{ textAlign: "left", padding: "0.25rem 0.4rem" }}>
                    {r.displayName}
                    {!r.verified && (
                      <span className="badge" title={t("Not signed in - grouped by nickname only", "Non connecté - regroupé par pseudo uniquement")}>
                        {t("guest", "invité")}
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      ...num,
                      color: r.draw ? "var(--text-dim)" : r.won ? "var(--accent)" : undefined,
                    }}
                  >
                    {r.draw ? t("draw", "nul") : r.won ? t("won", "gagné") : t("lost", "perdu")}
                  </td>
                  <td style={num}>{r.shots}</td>
                  <td style={{ ...num, color: "var(--hit)" }}>{r.hits}</td>
                  <td style={{ ...num, color: "var(--sunk)" }}>{r.sunk}</td>
                  <td style={num}>{Math.round(r.accuracy * 100)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span className="muted" style={{ fontSize: "0.7rem" }}>
        {t(
          "Click a heading to sort; click again to flip. Click a date to open that match's recap.",
          "Cliquez sur un en-tête pour trier ; cliquez à nouveau pour inverser. Cliquez sur une date pour ouvrir le résumé de cette partie."
        )}
      </span>
    </div>
  );
}
