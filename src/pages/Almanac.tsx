import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { fetchMatchFleets, fetchMatchEvents, fetchParticipants, fetchProfiles, profileName, type Profile } from "../lib/profiles";
import { fetchArchivedMatches, ARCHIVE_LIST_LIMIT, type ArchivedMatchListing } from "../lib/matchArchive";
import { buildScoutingReports } from "../lib/scouting";
import { CaptainCards } from "../components/CaptainCards";
import { HallOfFame, BattleLine } from "../components/HallOfFame";
import { squareWeights, rateBattles, type BattleRating } from "../lib/battleRating";
import { setMatchVoided, useAdminStatus } from "../lib/admin";
import { boardResolver } from "../lib/battleRatingBoards";
import type { ParticipantRow } from "../lib/careerStats";
import { matchName } from "../lib/matchName";
import { teamName, teamHex } from "../lib/teamColors";
import { detectSquareSet, rowSquareSet, busiestSquareSet, squareSet, displaySquareSet, DEFAULT_SQUARE_SET, type SquareSetId } from "../lib/challenges";
import { SquareSetTabs } from "../components/SquareSetTabs";
import { SiteFooter } from "../components/SiteFooter";
import {
  placementHeatmap,
  shotHeatmap,
  bossStats,
  fastestKills,
  boardSizesPresent,
  playerPace,
  bossFrequency,
  mergeSquareStats,
  matchShape,
  groupEventsByMatch,
  type MatchFleetRow,
  type MatchEventRow,
  type Heatmap,
  type SquareRow,
  type PlayerPace,
} from "../lib/almanac";
import { SortHeader, useSortColumns, type SortColumn } from "../components/SortHeader";
import { squarePace, MIN_GAPS_FOR_PACE } from "../lib/squarePace";
import { useT } from "../lib/language";

const COL_LETTERS = "ABCDEFGHIJKLMNOPQR";

export function Almanac() {
  const t = useT();
  const [fleets, setFleets] = useState<MatchFleetRow[] | null>(null);
  const [allEvents, setAllEvents] = useState<MatchEventRow[]>([]);
  const [allParts, setAllParts] = useState<ParticipantRow[]>([]);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [mode, setMode] = useState<"ships" | "shots">("ships");
  const [size, setSize] = useState<number | null>(null);
  // A captain's page links straight into their Hall of Fame entries - ?view=fame&captain=<key>&set=<id>
  // - so the tab, the filter and the board can all arrive in the URL. Read once, as starting values.
  const [params] = useSearchParams();
  const linkedSet = params.get("set");
  const [setId, setSetId] = useState<SquareSetId | null>(
    linkedSet && squareSet(linkedSet).id === linkedSet ? (linkedSet as SquareSetId) : null
  );
  const [archived, setArchived] = useState<ArchivedMatchListing[]>([]);
  const [view, setView] = useState<"patterns" | "captains" | "game" | "fame">(
    params.get("view") === "fame" ? "fame" : "patterns"
  );
  const [fameCaptain, setFameCaptain] = useState<string | null>(params.get("captain"));
  /** Which match the "Per Game" tab is showing. Null defaults to the newest match on this board. */
  const [gameKey, setGameKey] = useState<string | null>(null);

  // Voiding from the Hall of Fame. It is the one place an admin can reach a match whose recap the
  // 30-day sweep has taken - the admin list is built from match_reports and cannot see those.
  const { isAdmin } = useAdminStatus();
  const [reload, setReload] = useState(0);
  const [lastVoided, setLastVoided] = useState<{ matchKey: string; label: string } | null>(null);
  async function voidBattle(r: BattleRating) {
    const label = `${r.roomCode ?? r.matchKey.split(":")[0]} (${new Date(r.finishedAt).toLocaleDateString()})`;
    const ok = window.confirm(
      t(
        `Void the whole match ${label}? Every captain's results from it stop counting: careers, the leaderboard, the record book, the Almanac and this list. You can undo it straight after.`,
        `Invalider toute la partie ${label} ? Les résultats de tous les capitaines cessent de compter : carrières, classement, livre des records, almanach et cette liste. Vous pourrez annuler juste après.`
      )
    );
    if (!ok) return;
    try {
      await setMatchVoided(r.matchKey, true);
      setLastVoided({ matchKey: r.matchKey, label });
      setReload((n) => n + 1);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }
  async function undoVoid() {
    if (!lastVoided) return;
    try {
      await setMatchVoided(lastVoided.matchKey, false);
      setLastVoided(null);
      setReload((n) => n + 1);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void (async () => {
      const [f, e, p, m] = await Promise.all([
        fetchMatchFleets(),
        fetchMatchEvents(),
        fetchParticipants(),
        fetchArchivedMatches(),
      ]);
      setFleets(f as unknown as MatchFleetRow[]);
      setAllEvents(e as unknown as MatchEventRow[]);
      setAllParts(p);
      setArchived(m);
      setSetId((current) => current ?? busiestSquareSet(e as unknown as MatchEventRow[]));
      // Avatars and chosen names for the captain cards. Signed-in players only - a guest record has
      // no profile row to read.
      setProfiles(await fetchProfiles(p.map((r) => r.user_id).filter(Boolean) as string[]));
    })();
    // `reload` re-reads after a void: setMatchVoided has already dropped the cached feeds.
  }, [reload]);

  const shownSet = setId ?? DEFAULT_SQUARE_SET;

  /**
   * Which set each archived match was played on.
   *
   * The stored column is the answer for anything archived since square sets existed. Rows without
   * one are reconstructed instead - rebuild the board with each set and see which puts the logged
   * names in the logged places - which covers both matches that predate the column and any archived
   * by a client running ahead of the migration.
   */
  const setByMatch = useMemo(() => {
    const out = new Map<string, SquareSetId>();
    for (const [key, evs] of groupEventsByMatch(allEvents)) {
      const stored = evs.find((e) => e.square_set)?.square_set;
      if (stored) {
        // Folded, because this map decides which TAB a match sits under. The board it was actually
        // dealt from is recovered in `freq` below, which is the only reader here that needs it.
        out.set(key, displaySquareSet(stored));
        continue;
      }
      const roomId = evs.find((e) => e.room_id)?.room_id;
      const fired = evs
        .filter((e) => e.challenge_name && e.cell_index >= 0)
        .map((e) => ({ cell: e.cell_index, name: e.challenge_name as string }));
      const cells = evs[0].board_size * evs[0].board_size;
      const perm = evs.find((e) => e.board_perm)?.board_perm ?? null;
      out.set(key, displaySquareSet((roomId ? detectSquareSet(roomId, cells, fired, null, perm) : null) ?? DEFAULT_SQUARE_SET));
    }
    return out;
  }, [allEvents]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const id of setByMatch.values()) out[id] = (out[id] ?? 0) + 1;
    return out;
  }, [setByMatch]);

  const events = useMemo(
    () => allEvents.filter((e) => (setByMatch.get(e.match_key) ?? DEFAULT_SQUARE_SET) === shownSet),
    [allEvents, setByMatch, shownSet]
  );
  const parts = useMemo(
    () => allParts.filter((p) => (setByMatch.get(p.match_key) ?? rowSquareSet(p)) === shownSet),
    [allParts, setByMatch, shownSet]
  );
  // Fleets feed the "where ships hide" heatmap. Filtered too: hiding places on a 5x5 objectives
  // board have nothing to say about a 10x10 boss board.
  const shownFleets = useMemo(
    () => (fleets ?? []).filter((f) => (setByMatch.get(f.match_key) ?? rowSquareSet(f)) === shownSet),
    [fleets, setByMatch, shownSet]
  );

  // Folded, like every other reader that groups by board - see the comment on MatchHistory's own
  // filter, which this replaces. Newest first, for both the match history list and the Per Game
  // picker below.
  const matchesForSet = useMemo(
    () =>
      [...archived]
        .filter((m) => displaySquareSet(m.square_set) === shownSet)
        .sort((a, b) => b.finished_at.localeCompare(a.finished_at)),
    [archived, shownSet]
  );
  const effectiveGameKey = gameKey ?? matchesForSet[0]?.match_key ?? null;

  // Everything below this point read `events`/`parts`/`shownFleets` (the whole board) before the
  // Per Game tab existed. It still does for Patterns - only the Per Game tab narrows it further, to
  // one match - so every aggregate downstream (heatmap, squares, pace, match shape) is honest for
  // whichever one it's showing without needing two copies of the JSX that renders them.
  const activeEvents = useMemo(
    () => (view === "game" ? events.filter((e) => e.match_key === effectiveGameKey) : events),
    [view, effectiveGameKey, events]
  );
  const activeParts = useMemo(
    () => (view === "game" ? parts.filter((p) => p.match_key === effectiveGameKey) : parts),
    [view, effectiveGameKey, parts]
  );
  const activeFleets = useMemo(
    () => (view === "game" ? shownFleets.filter((f) => f.match_key === effectiveGameKey) : shownFleets),
    [view, effectiveGameKey, shownFleets]
  );

  const reports = useMemo(() => buildScoutingReports(parts, events), [parts, events]);

  const pace = useMemo(() => playerPace(activeEvents), [activeEvents]);
  // The leaderboard's measure of the same thing, shown beside this page's. See the pace table.
  const paceMedians = useMemo(() => squarePace(activeEvents), [activeEvents]);
  const shape = useMemo(() => matchShape(activeEvents, activeParts), [activeEvents, activeParts]);
  // Rebuilds each board's full challenge list from its room id, which is what reveals squares
  // nobody ever fired at - see boardResolver, shared with the recap's scoreboard.
  const resolveBoard = useMemo(() => boardResolver(shownSet), [shownSet]);
  // The whole board's, whatever tab is open: square weights are a property of the board, so a
  // battle's rating must not change with which match the Per Game picker happens to be on.
  const boardFreq = useMemo(() => bossFrequency(events, resolveBoard), [events, resolveBoard]);
  // Rebuilding every board is the expensive part, so only the Per Game tab pays for a second pass.
  const freq = useMemo(
    () => (view === "game" ? bossFrequency(activeEvents, resolveBoard) : boardFreq),
    [view, activeEvents, resolveBoard, boardFreq]
  );

  const ratings = useMemo(
    () => rateBattles(parts, events, squareWeights(events, boardFreq)),
    [parts, events, boardFreq]
  );
  const gameRatings = useMemo(
    () => ratings.filter((r) => r.matchKey === effectiveGameKey),
    [ratings, effectiveGameKey]
  );

  const sizes = useMemo(() => boardSizesPresent(activeFleets, activeEvents), [activeFleets, activeEvents]);
  const boardSize = size ?? sizes[0] ?? 10;

  const map = useMemo(
    () => (mode === "ships" ? placementHeatmap(activeFleets, boardSize) : shotHeatmap(activeEvents, boardSize)),
    [mode, activeFleets, activeEvents, boardSize]
  );
  // Every square on the board in one row, not just the ones somebody shot at - see mergeSquareStats.
  const squares = useMemo(() => mergeSquareStats(bossStats(activeEvents), freq), [activeEvents, freq]);
  const records = useMemo(() => fastestKills(activeEvents, 8), [activeEvents]);

  if (fleets === null) return <p className="muted">{t("Consulting the almanac...", "Consultation de l'almanach...")}</p>;

  const hasData = activeFleets.length > 0 || activeEvents.length > 0;

  return (
    <div className="stack" style={{ width: "min(900px, 100%)", gap: "0.9rem" }}>
      <div style={{ textAlign: "center" }}>
        <h1>{t("Almanac", "Almanach")}</h1>
        <p className="muted">{t("Patterns across every match on one board.", "Tendances sur toutes les parties d'un même plateau.")}</p>
      </div>

      {/* Outside the empty check, so a set with nothing charted can still be switched away from. */}
      <div className="panel stack" style={{ gap: "0.4rem" }}>
        <SquareSetTabs value={shownSet} onChange={setSetId} counts={counts} />
        <span className="muted" style={{ fontSize: "0.72rem" }}>{squareSet(shownSet).blurb}</span>
        <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
          <button
            onClick={() => setView("patterns")}
            style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: view === "patterns" ? "var(--accent)" : undefined }}
          >
            {t("Patterns", "Tendances")}
          </button>
          <button
            onClick={() => setView("captains")}
            style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: view === "captains" ? "var(--accent)" : undefined }}
          >
            {t("Captains", "Capitaines")}
          </button>
          <button
            onClick={() => setView("game")}
            style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: view === "game" ? "var(--accent)" : undefined }}
          >
            {t("Per Game", "Par partie")}
          </button>
          <button
            onClick={() => setView("fame")}
            style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: view === "fame" ? "var(--accent)" : undefined }}
          >
            {t("Hall of Fame", "Panthéon")}
          </button>
        </div>
      </div>

      {view === "captains" ? (
        <CaptainCards reports={reports} profiles={profiles} setId={shownSet} />
      ) : view === "fame" ? (
        <HallOfFame
          ratings={ratings}
          profiles={profiles}
          setId={shownSet}
          captain={fameCaptain}
          onCaptain={setFameCaptain}
          onVoid={isAdmin ? (r) => void voidBattle(r) : undefined}
          lastVoided={isAdmin ? lastVoided : null}
          onUndoVoid={() => void undoVoid()}
        />
      ) : (
        <>
        {view === "patterns" ? (
          // Folded, like every other reader that groups by board: a variant - the trimmed boss cut
          // dealt to small crews - has no tab of its own, so matching its stored id raw dropped
          // those matches out of the list and out of the count above every aggregate they feed.
          <MatchHistory
            matches={matchesForSet}
            // Against the ceiling, so the count is a window rather than a total - see ARCHIVE_LIST_LIMIT.
            capped={archived.length >= ARCHIVE_LIST_LIMIT}
          />
        ) : (
          <>
            <GamePicker matches={matchesForSet} value={effectiveGameKey} onChange={setGameKey} />
            {/* Every rated captain in this match, best first, so the MVP is the top line and the
                rest of the crew can be read against them. */}
            {gameRatings.length > 0 && (
              <div className="panel stack" style={{ gap: "0.45rem" }}>
                <h3 style={{ margin: 0 }}>{t("Battle ratings", "Notes de bataille")}</h3>
                {gameRatings.map((r) => (
                  <BattleLine key={r.key} battle={r} profiles={profiles} setId={shownSet} />
                ))}
              </div>
            )}
          </>
        )}

        {!hasData ? (
          <div className="panel stack" style={{ alignItems: "center", textAlign: "center" }}>
            <p className="muted" style={{ margin: 0 }}>
              {t("Nothing charted yet. Finish a match and the almanac starts filling in.", "Rien à afficher pour l'instant. Terminez une partie et l'almanach commence à se remplir.")}
            </p>
            <Link to="/">{t("Back to the harbor", "Retour au port")}</Link>
          </div>
        ) : (
          <>
            {shape.matches > 0 && (
              <div className="row" style={{ gap: "0.75rem", alignItems: "stretch", flexWrap: "wrap" }}>
                <BigStat
                  label={t("First-blood win rate", "Taux de victoire au premier sang")}
                  value={`${Math.round(shape.firstBloodWinRate * 100)}%`}
                  sub={`${shape.firstBloodSample} ${t("decided matches", "parties décisives")}`}
                  hint={t("How often the side that lands the opening hit goes on to win", "À quelle fréquence le camp qui place le premier coup finit par gagner")}
                />
                {shape.bloodiest && (
                  <BigStat
                    label={t("Bloodiest square", "Case la plus sanglante")}
                    value={shape.bloodiest.name}
                    sub={`${shape.bloodiest.sinkings} ${shape.bloodiest.sinkings === 1 ? t("ship", "navire") : t("ships", "navires")} ${t("sunk on it", "coulés dessus")}`}
                    hint={t("The square that has finished off the most ships", "La case qui a coulé le plus de navires")}
                  />
                )}
                {shape.medianMatchSeconds !== null && (
                  <BigStat
                    label={t("Typical match", "Partie type")}
                    value={fmt(shape.medianMatchSeconds)}
                    sub={`${t("median of", "médiane sur")} ${shape.timedMatches} ${shape.timedMatches === 1 ? t("match", "partie") : t("matches", "parties")}`}
                    hint={t("How long a match on this board usually runs", "Durée habituelle d'une partie sur ce plateau")}
                  />
                )}
                <BigStat
                  label={t("Flawless wins", "Victoires sans perte")}
                  value={shape.flawlessWins}
                  sub={t("won without losing a ship", "gagnées sans perdre un navire")}
                  hint={t("Victories where the winning fleet finished intact", "Victoires où la flotte gagnante a fini intacte")}
                />
              </div>
            )}

            <div className="panel stack" style={{ gap: "0.6rem" }}>
              <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
                <h3 style={{ margin: 0 }}>{t("Heatmap", "Carte de chaleur")}</h3>
                <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
                  <button
                    onClick={() => setMode("ships")}
                    style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: mode === "ships" ? "var(--accent)" : undefined }}
                  >
                    {t("Where ships hide", "Où se cachent les navires")}
                  </button>
                  <button
                    onClick={() => setMode("shots")}
                    style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: mode === "shots" ? "var(--accent)" : undefined }}
                  >
                    {t("Where people shoot", "Où les gens tirent")}
                  </button>
                  {sizes.length > 1 &&
                    sizes.map((s) => (
                      <button
                        key={s}
                        onClick={() => setSize(s)}
                        style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: boardSize === s ? "var(--accent)" : undefined }}
                      >
                        {s}x{s}
                      </button>
                    ))}
                </div>
              </div>

              <span className="muted" style={{ fontSize: "0.75rem" }}>
                {mode === "ships"
                  ? `${t("Cells most often occupied by a ship", "Cases les plus souvent occupées par un navire")} - ${map.samples} ${t("fleets", "flottes")}, ${map.total} ${t("ship squares", "cases occupées")}.`
                  : `${t("Cells most often fired at", "Cases les plus souvent visées")} - ${map.total} ${t("shots across", "tirs sur")} ${map.samples} ${t("matches", "parties")}.`}
              </span>

              <HeatGrid map={map} />
            </div>

            <SquaresTable rows={squares} />

            {pace.length > 0 && (
              <PaceTable rows={pace} medians={paceMedians} profiles={profiles} setId={shownSet} />
            )}

            {records.length > 0 && (
              <div className="panel stack" style={{ gap: "0.25rem" }}>
                <h3 style={{ margin: 0 }}>{t("Quickest squares on record", "Cases les plus rapides au tableau")}</h3>
                <span className="muted" style={{ fontSize: "0.7rem" }}>
                  {t("Timed from the captain's previous square. Misses count.", "Chronométré depuis la case précédente du capitaine. Les tirs manqués comptent.")}
                  {" "}
                  {t(
                    "Only counting squares marked after 9/20, when auto-mark became a prerequisite for speed records.",
                    "Ne compte que les cases marquées après le 20/09, date à laquelle le marquage automatique est devenu obligatoire pour les records de vitesse."
                  )}
                </span>
                {records.map((r, i) => (
                  <div
                    key={`${r.matchKey}-${r.challenge}-${i}`}
                    className="row"
                    style={{ justifyContent: "space-between", fontSize: "0.82rem", gap: "0.5rem" }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span className="muted">{i + 1}. </span>
                      <strong>{r.challenge ?? t("Unknown", "Inconnu")}</strong>
                      <span className="muted"> - {r.nickname}</span>
                      {/* Which square it was timed from: the pair IS the record, the same way the
                          record book's gap entry reads "X then Y". */}
                      {r.previous && <span className="muted"> · {t("after", "après")} {r.previous}</span>}
                      {r.result === "sunk" && <span style={{ color: "var(--sunk)" }}> · {t("sank a ship", "a coulé un navire")}</span>}
                      {r.result === "hit" && <span style={{ color: "var(--hit)" }}> · {t("hit", "touché")}</span>}
                    </span>
                    <strong style={{ color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}>{fmt(r.seconds)}</strong>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        </>
      )}
      {/* Page level, and outside the tab switch: it used to live inside the pace table's panel, so
          it drew halfway down the page above "Quickest squares", and vanished entirely on the
          Captains tab or whenever no captain had a pace yet. */}
      <SiteFooter />
    </div>
  );
}

function fmt(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** How many matches to list before the rest go behind "Show all". */
const HISTORY_PREVIEW = 12;

/**
 * Every finished match, each one a link to its own permanent recap.
 *
 * The Almanac is otherwise entirely aggregate - it tells you that people hug the edges without
 * ever letting you look at a single game. This is the way back down to one match.
 *
 * Costs no storage: match_reports has been written at the end of every match since the record
 * books existed, and this reads rows that were already sitting there.
 */
function MatchHistory({ matches, capped }: { matches: ArchivedMatchListing[]; capped?: boolean }) {
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  if (matches.length === 0) return null;

  const shown = showAll ? matches : matches.slice(0, HISTORY_PREVIEW);

  return (
    <div className="panel stack" style={{ gap: "0.3rem" }}>
      <h3 style={{ margin: 0 }}>{t("Match history", "Historique des parties")}</h3>
      <span className="muted" style={{ fontSize: "0.7rem" }}>
        {capped ? t("The newest ", "Les ") : ""}
        {matches.length} {matches.length === 1 ? t("finished match", "partie terminée") : t("finished matches", "parties terminées")}
        {capped
          ? t(` of the last ${ARCHIVE_LIST_LIMIT} played`, ` sur les ${ARCHIVE_LIST_LIMIT} dernières jouées`)
          : ""}
        . {t("Open one for its recap and replay.", "Ouvrez-en une pour son résumé et sa rediffusion.")}
      </span>
      {shown.map((m) => {
        const when = new Date(m.finished_at);
        return (
          <Link
            key={m.match_key}
            to={`/match/${encodeURIComponent(m.match_key)}`}
            className="row"
            style={{
              justifyContent: "space-between",
              gap: "0.5rem",
              fontSize: "0.8rem",
              padding: "0.25rem 0",
              borderTop: "1px solid var(--panel-border)",
              textDecoration: "none",
            }}
          >
            <span style={{ minWidth: 0 }}>
              {/* The name leads. A row headed by a room code is a primary key, and the same room is
                  replayed all evening - "The Knife Fight" is what tells you which night this was. */}
              <strong>
                {matchName({
                  roomCode: m.room_code,
                  winnerTeam: m.winner_team,
                  duration: m.duration,
                  totalShots: m.total_shots,
                  stats: m.summary?.stats ?? [],
                  awards: m.summary?.awards ?? [],
                })}
              </strong>
              <span className="muted"> · </span>
              {m.winner_team === null ? (
                <span className="muted">{t("draw", "match nul")}</span>
              ) : (
                <span style={{ color: teamHex(m.winner_team) }}>{teamName(m.winner_team)} {t("won", "a gagné")}</span>
              )}
              {/* Beside the result rather than replacing it, because a practice match still HAD a
                  result and the row is still worth reading. What the tag adds is why you won't find
                  that result anywhere else. */}
              {m.practice && (
                <span style={{ color: "var(--hit)", fontSize: "0.68rem", letterSpacing: "0.06em" }}>
                  {" "}
                  · {t("PRACTICE", "ENTRAÎNEMENT")}
                </span>
              )}
              <div className="muted" style={{ fontSize: "0.68rem" }}>
                {when.toLocaleDateString()} {when.toLocaleTimeString()}
              </div>
            </span>
            <span className="muted" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              {m.total_shots} {t("shots", "tirs")}
              <div style={{ fontSize: "0.68rem" }}>{m.duration ?? ""}</div>
            </span>
          </Link>
        );
      })}
      {matches.length > HISTORY_PREVIEW && (
        <button
          onClick={() => setShowAll((v) => !v)}
          style={{ alignSelf: "flex-start", fontSize: "0.72rem", marginTop: "0.3rem" }}
        >
          {showAll ? t("Show fewer", "Afficher moins") : `${t("Show all", "Afficher tout")} ${matches.length}`}
        </button>
      )}
    </div>
  );
}

/**
 * Picks one match, so everything below - heatmap, squares, pace, match shape - can recompute for
 * it alone instead of the whole board. The Almanac is otherwise entirely aggregate; this is the
 * same "one match at a time" idea as MatchHistory, but reusing the aggregate views themselves
 * rather than sending the reader off to the standalone recap.
 */
function GamePicker({
  matches,
  value,
  onChange,
}: {
  matches: ArchivedMatchListing[];
  value: string | null;
  onChange: (key: string) => void;
}) {
  const t = useT();
  if (matches.length === 0) return null;

  return (
    <div className="panel stack" style={{ gap: "0.4rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>{t("Choose a match", "Choisir une partie")}</h3>
        {value && (
          <Link to={`/match/${encodeURIComponent(value)}`} style={{ fontSize: "0.75rem" }}>
            {t("Open full recap →", "Voir le résumé complet →")}
          </Link>
        )}
      </div>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        style={{ fontSize: "0.82rem", padding: "0.3rem 0.4rem" }}
      >
        {matches.map((m) => {
          const when = new Date(m.finished_at);
          const label = matchName({
            roomCode: m.room_code,
            winnerTeam: m.winner_team,
            duration: m.duration,
            totalShots: m.total_shots,
            stats: m.summary?.stats ?? [],
            awards: m.summary?.awards ?? [],
          });
          return (
            <option key={m.match_key} value={m.match_key}>
              {when.toLocaleDateString()} - {label}
            </option>
          );
        })}
      </select>
    </div>
  );
}

/**
 * One headline number, or one headline name.
 *
 * The size steps down for a value that is a name rather than a figure. "71%" and "Astel,
 * Naturalborn of the Void" are both values here, and the boss names run to thirty characters
 * against a tile nine rems wide - at the figure size a long one would either spill out of the
 * panel or drag the whole row taller than the three beside it.
 */
function BigStat({ label, value, sub, hint }: { label: string; value: string | number; sub?: string; hint?: string }) {
  const text = String(value);
  const size = typeof value === "number" || text.length <= 12 ? "1.9rem" : text.length <= 20 ? "1.15rem" : "1rem";

  return (
    <div className="panel stack" style={{ flex: "1 1 10rem", minWidth: "9rem", gap: "0.1rem" }} title={hint}>
      <span className="muted" style={{ fontSize: "0.66rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
        {label}
      </span>
      <span
        style={{
          fontSize: size,
          fontWeight: 700,
          lineHeight: 1.15,
          color: "var(--accent)",
          // A long name breaks across lines rather than out of the panel.
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </span>
      {sub && <span className="muted" style={{ fontSize: "0.7rem" }}>{sub}</span>}
    </div>
  );
}

/**
 * Grid where each cell's brightness is its share of the busiest cell.
 *
 * Normalized against the max rather than the total, because with 100 cells every absolute share
 * is tiny - scaling to the hottest cell is what makes the pattern legible at all.
 */
function HeatGrid({ map }: { map: Heatmap }) {
  const { boardSize, counts, max } = map;

  return (
    <div style={{ overflowX: "auto" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `auto repeat(${boardSize}, minmax(1.5rem, 1fr))`,
          gap: 2,
          maxWidth: "34rem",
        }}
      >
        <div />
        {Array.from({ length: boardSize }, (_, c) => (
          <div key={`h${c}`} className="muted" style={{ textAlign: "center", fontSize: "0.65rem" }}>
            {COL_LETTERS[c] ?? c + 1}
          </div>
        ))}
        {/* Fragment with a key, not `<>`: the rows are a list, and the shorthand cannot carry one -
            keying the children inside it instead left React warning on every render. */}
        {Array.from({ length: boardSize }, (_, r) => (
          <Fragment key={`row${r}`}>
            <div className="muted" style={{ fontSize: "0.65rem", alignSelf: "center", paddingRight: 4 }}>
              {r + 1}
            </div>
            {Array.from({ length: boardSize }, (_, c) => {
              const n = counts[r * boardSize + c] ?? 0;
              const ratio = max > 0 ? n / max : 0;
              return (
                <div
                  key={`c${r}-${c}`}
                  title={`${COL_LETTERS[c] ?? c + 1}${r + 1} - ${n}`}
                  style={{
                    aspectRatio: "1",
                    borderRadius: 2,
                    // Brass at full intensity, fading to the board's own water color.
                    background: `color-mix(in srgb, var(--accent) ${Math.round(ratio * 100)}%, var(--cell))`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "0.6rem",
                    color: ratio > 0.55 ? "#241703" : "var(--text-dim)",
                  }}
                >
                  {n > 0 ? n : ""}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

type SquareSortKey = "name" | "attempts" | "hitRate" | "median" | "appeared" | "ignored" | "opened" | "fastest";

/**
 * Every number the almanac holds about a square, in one sortable table.
 *
 * This replaced three separate boards - the boss table, "most ignored" and "opening shots" - which
 * were three top-eight cuts of the same rows. A cut of eight is a headline, and headlines are what
 * the panels above are for; the question people actually bring to this table is about one square
 * they care about, and that square is almost never in anybody's top eight. Sorting answers both:
 * click Ignored and the old "most ignored" board is the top of the column, only it keeps going.
 */
/**
 * Built from `t` rather than held as a plain constant: the labels and tooltips are user-facing
 * text, and this table config lives outside any component, so the translation function is passed
 * in and called at the one place (SquaresTable) that actually has it.
 */
function squareColumns(t: (en: string, fr: string) => string): SortColumn<SquareSortKey>[] {
  return [
    {
      key: "name",
      label: t("Square", "Case"),
      align: "left",
      firstDirection: "asc",
      title: t("The square as it reads on the board.", "La case telle qu'elle apparaît sur le plateau."),
    },
    {
      key: "attempts",
      label: t("Shot at", "Visée"),
      align: "right",
      firstDirection: "desc",
      title: t(
        "Times this square has been taken, across every match on this board. One per trigger-pull, hit or miss.",
        "Nombre de fois où cette case a été visée, sur toutes les parties de ce plateau. Un tir compte, qu'il touche ou non.",
      ),
    },
    {
      key: "hitRate",
      label: t("Hit %", "% de réussite"),
      align: "right",
      firstDirection: "desc",
      title: t(
        "Share of those shots that landed on an enemy ship. Says where people hide ships, not how hard the square is.",
        "Part de ces tirs qui ont touché un navire ennemi. Indique où les gens cachent leurs navires, pas la difficulté de la case.",
      ),
    },
    {
      key: "median",
      label: t("Median", "Médiane"),
      sublabel: t("on the clock", "sur l'horloge"),
      align: "right",
      firstDirection: "asc",
      title: t(
        "Median time into the match when this square falls. When people take it, not how long it takes to beat.",
        "Temps médian de la partie auquel cette case tombe. Indique quand elle est prise, pas le temps qu'il faut pour la vaincre.",
      ),
    },
    {
      key: "appeared",
      label: t("Seen", "Vue"),
      align: "right",
      firstDirection: "desc",
      title: t(
        "Boards this square has appeared on, whether or not anybody shot at it.",
        "Plateaux sur lesquels cette case est apparue, que quelqu'un y ait tiré ou non.",
      ),
    },
    {
      key: "ignored",
      label: t("Ignored", "Ignorée"),
      align: "right",
      firstDirection: "desc",
      title: t(
        "Share of the boards it appeared on where nobody fired at it. 100% means it has never been taken.",
        "Part des plateaux où elle est apparue sans que personne n'y tire. 100 % signifie qu'elle n'a jamais été prise.",
      ),
    },
    {
      key: "opened",
      label: t("Opened", "Ouverture"),
      align: "right",
      firstDirection: "desc",
      title: t(
        "Times this square was the very first shot of a match.",
        "Nombre de fois où cette case a été le tout premier tir d'une partie.",
      ),
    },
    {
      // "Fastest" was a lie, and an expensive one: this is a position on the match clock, and the
      // panel directly below it ranks squares by how long the FIGHT took, in the same m:ss format.
      // Two numbers that look identical and mean opposite things. The heading now says which it is,
      // the way the Median column's "on the clock" already did.
      key: "fastest",
      label: t("Earliest", "Plus tôt"),
      sublabel: t("on the clock", "sur l'horloge"),
      align: "left",
      firstDirection: "asc",
      title: t(
        "The earliest point in a match this square has ever fallen, and who took it. When it was reached, not how long the fight lasted.",
        "Le moment le plus tôt où cette case est tombée, et qui l'a prise. Quand elle a été atteinte, pas la durée du combat.",
      ),
    },
  ];
}

/**
 * Ascending comparison for one column. The caller flips it for descending.
 *
 * The secondary keys are not decoration. Sorting on a rate alone puts whoever has the smallest
 * sample on top, so every rate falls back to the volume behind it - which keeps a square seen once
 * and skipped from outranking one skipped on thirty boards out of thirty.
 */
function compareSquares(a: SquareRow, b: SquareRow, key: SquareSortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "attempts":
      return a.attempts - b.attempts || (a.hitRate ?? 0) - (b.hitRate ?? 0);
    case "hitRate":
      return (a.hitRate ?? 0) - (b.hitRate ?? 0) || a.attempts - b.attempts;
    case "median":
      return (a.medianSeconds ?? 0) - (b.medianSeconds ?? 0) || b.timed - a.timed;
    case "appeared":
      return a.appeared - b.appeared || a.attempts - b.attempts;
    case "ignored":
      return a.missRate - b.missRate || a.appeared - b.appeared;
    case "opened":
      return a.opened - b.opened || a.appeared - b.appeared;
    case "fastest":
      return (a.fastest?.seconds ?? 0) - (b.fastest?.seconds ?? 0) || a.attempts - b.attempts;
  }
}

/** Columns where a square can simply have no number yet, which is not the same as having a low one. */
function squareMissing(row: SquareRow, key: SquareSortKey): boolean {
  if (key === "hitRate") return row.hitRate === null;
  if (key === "median") return row.medianSeconds === null;
  if (key === "fastest") return row.fastest === null;
  return false;
}

function SquaresTable({ rows }: { rows: SquareRow[] }) {
  const t = useT();
  const columns = squareColumns(t);
  const { sort, direction, sortBy } = useSortColumns(columns, "attempts");

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      // A square nobody has fired at yet sits at the bottom in BOTH directions rather than sorting
      // as though its time were zero - it would otherwise top every timing column it cannot answer.
      const am = squareMissing(a, sort);
      const bm = squareMissing(b, sort);
      if (am !== bm) return am ? 1 : -1;
      const cmp = compareSquares(a, b, sort);
      return direction === "asc" ? cmp : -cmp;
    });
  }, [rows, sort, direction]);

  if (rows.length === 0) return null;

  const untouched = rows.filter((r) => r.fired === 0).length;

  return (
    <div className="panel stack" style={{ gap: "0.4rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>{t("Squares", "Cases")}</h3>
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          {rows.length} {t("squares seen", "cases vues")}
          {untouched > 0 ? ` · ${untouched} ${t("never taken", "jamais prises")}` : ""}
        </span>
      </div>
      <span className="muted" style={{ fontSize: "0.72rem" }}>
        {t("Every square the board deals, shot at or not. Times are medians from when firing opens.", "Chaque case du plateau, visée ou non. Les temps sont des médianes depuis l'ouverture des tirs.")}
        {" "}
        {t(
          "Times only count squares marked after 9/20, when auto-mark became a prerequisite for speed records.",
          "Les temps ne comptent que les cases marquées après le 20/09, date à laquelle le marquage automatique est devenu obligatoire pour les records de vitesse."
        )}
      </span>
      <div style={{ overflowX: "auto", maxHeight: "30rem", overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
          <SortHeader columns={columns} sort={sort} direction={direction} onSort={sortBy} leading="#" />
          <tbody>
            {sorted.map((r, i) => {
              const num = { padding: "0.2rem 0.4rem", fontVariantNumeric: "tabular-nums" as const };
              // Never taken on any board it appeared on. Dimmed rather than flagged: at the top of
              // the Ignored column it is the whole point, and everywhere else it is just context.
              const untaken = r.appeared > 0 && r.fired === 0;
              return (
                <tr key={r.name} style={{ textAlign: "right", borderTop: "1px solid var(--panel-border)" }}>
                  <td style={{ textAlign: "left", padding: "0.2rem 0.4rem", color: "var(--text-dim)" }}>{i + 1}</td>
                  <td style={{ textAlign: "left", padding: "0.2rem 0.4rem", color: untaken ? "var(--text-dim)" : undefined }}>
                    {r.name}
                  </td>
                  <td style={{ ...num, color: r.attempts === 0 ? "var(--text-dim)" : undefined }}>{r.attempts}</td>
                  <td style={num}>{r.hitRate !== null ? `${Math.round(r.hitRate * 100)}%` : "-"}</td>
                  <td style={num} title={r.timed > 0 ? `${r.timed} ${r.timed === 1 ? t("timed shot", "tir chronométré") : t("timed shots", "tirs chronométrés")}` : undefined}>
                    {r.medianSeconds !== null ? fmt(r.medianSeconds) : "-"}
                  </td>
                  {/* A dash rather than 0 when the board could not be rebuilt: the match's room row
                      is gone, so "seen 0 times" would be a claim the data cannot make. */}
                  <td style={{ ...num, color: r.appeared === 0 ? "var(--text-dim)" : undefined }}>
                    {r.appeared > 0 ? r.appeared : "-"}
                  </td>
                  <td style={{ ...num, color: untaken ? "var(--accent)" : r.missRate === 0 ? "var(--text-dim)" : undefined }}>
                    {r.appeared > 0 ? `${Math.round(r.missRate * 100)}%` : "-"}
                  </td>
                  <td style={{ ...num, color: r.opened === 0 ? "var(--text-dim)" : undefined }}>{r.opened}</td>
                  <td style={{ textAlign: "left", padding: "0.2rem 0.4rem" }} className="muted">
                    {r.fastest ? `${fmt(r.fastest.seconds)} - ${r.fastest.nickname}` : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span className="muted" style={{ fontSize: "0.7rem" }}>
        {t("Click a heading to sort; click again to flip. Hover a heading for what the number means.", "Cliquez un en-tête pour trier ; cliquez à nouveau pour inverser. Survolez un en-tête pour voir ce que le chiffre signifie.")}
      </span>
    </div>
  );
}

type PaceSortKey = "name" | "matches" | "shots" | "median" | "average" | "best";

/** Same reasoning as squareColumns above: built from `t`, called inside PaceTable where it's in scope. */
function paceColumns(t: (en: string, fr: string) => string): SortColumn<PaceSortKey>[] {
  return [
    {
      key: "name",
      label: t("Captain", "Capitaine"),
      align: "left",
      firstDirection: "asc",
      title: t(
        "Signed-in captains are grouped by account; guests by nickname, so two guests sharing a name share a row. Click a name for their full record on this board.",
        "Les capitaines connectés sont regroupés par compte, les invités par pseudo : deux invités partageant un nom partagent une ligne. Cliquez un nom pour son historique complet sur ce plateau.",
      ),
    },
    {
      key: "matches",
      label: t("Matches", "Parties"),
      align: "right",
      firstDirection: "desc",
      title: t("Finished matches they have fired in on this board.", "Parties terminées où ils ont tiré sur ce plateau."),
    },
    {
      key: "shots",
      label: t("Shots", "Tirs"),
      align: "right",
      firstDirection: "desc",
      title: t("Squares taken across all of them.", "Cases prises sur l'ensemble de ces parties."),
    },
    {
      key: "median",
      label: t("Pace", "Rythme"),
      sublabel: t("median", "médiane"),
      align: "right",
      firstDirection: "asc",
      title: t(
        `Square pace - the time from one square falling to the next, as a median across every square they have fired on this board. The same number the leaderboard shows. Needs ${MIN_GAPS_FOR_PACE} squares before it appears. Only counts squares marked after 9/20, when auto-mark became a prerequisite for speed records.`,
        `Rythme par case - le temps entre deux cases prises, en médiane sur toutes les cases visées sur ce plateau. Le même chiffre qu'affiche le classement. Nécessite ${MIN_GAPS_FOR_PACE} cases avant d'apparaître. Ne compte que les cases marquées après le 20/09, date à laquelle le marquage automatique est devenu obligatoire pour les records de vitesse.`,
      ),
    },
    {
      key: "average",
      label: t("Pace", "Rythme"),
      sublabel: t("average", "moyenne"),
      align: "right",
      firstDirection: "asc",
      title: t(
        "The same figure as a mean, worked out inside each match and then averaged across matches, so time between sessions never counts. Every gap counts, including the pair a duo boss fills at once.",
        "Le même chiffre en moyenne, calculé au sein de chaque partie puis moyenné entre les parties, pour que le temps entre deux sessions ne compte jamais. Chaque intervalle compte, y compris la paire qu'un boss en duo remplit d'un coup.",
      ),
    },
    {
      key: "best",
      label: t("Best match", "Meilleure partie"),
      align: "right",
      firstDirection: "asc",
      title: t(
        "Their fastest single match by that average. Click it to open the match.",
        "Leur partie la plus rapide selon cette moyenne. Cliquez pour ouvrir la partie.",
      ),
    },
  ];
}

/** A pace row: the page's own average, plus the leaderboard's median where there is enough for one. */
interface PaceRow extends PlayerPace {
  median: number | null;
}

function comparePace(a: PaceRow, b: PaceRow, key: PaceSortKey): number {
  switch (key) {
    case "name":
      return a.nickname.localeCompare(b.nickname);
    case "matches":
      return a.matches - b.matches || a.shots - b.shots;
    case "shots":
      return a.shots - b.shots || a.matches - b.matches;
    case "median":
      // Nulls are handled before this is reached - see the sort below.
      return (a.median ?? 0) - (b.median ?? 0) || b.shots - a.shots;
    case "average":
      return a.secondsPerShot - b.secondsPerShot || b.shots - a.shots;
    case "best":
      return (a.bestMatch?.seconds ?? 0) - (b.bestMatch?.seconds ?? 0) || b.shots - a.shots;
  }
}

/**
 * Every captain's pace, both ways of measuring it.
 *
 * Two columns because they are genuinely different numbers and the gap between them is itself
 * readable: the median asks what a normal square looks like for someone, the average asks how their
 * whole evening went, and one twenty-minute wall moves the second and leaves the first alone. A
 * captain whose average sits far above their median met a bad boss; they did not have a slow night.
 */
function PaceTable({
  rows,
  medians,
  profiles,
  setId,
}: {
  rows: PlayerPace[];
  medians: Map<string, number>;
  profiles: Map<string, Profile>;
  setId: SquareSetId;
}) {
  const t = useT();
  const columns = paceColumns(t);
  const { sort, direction, sortBy } = useSortColumns(columns, "median");

  const sorted = useMemo(() => {
    const withMedian: PaceRow[] = rows.map((r) => ({ ...r, median: medians.get(r.key) ?? null }));
    return withMedian.sort((a, b) => {
      // A captain without a median yet sits at the bottom in BOTH directions rather than sorting as
      // though they were infinitely fast.
      if (sort === "median" && a.median !== b.median && (a.median === null || b.median === null)) {
        return a.median === null ? 1 : -1;
      }
      const cmp = comparePace(a, b, sort);
      return direction === "asc" ? cmp : -cmp;
    });
  }, [rows, medians, sort, direction]);

  if (rows.length === 0) return null;

  return (
    <div className="panel stack" style={{ gap: "0.4rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>{t("Square pace", "Rythme par case")}</h3>
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          {sorted.length} {sorted.length === 1 ? t("captain", "capitaine") : t("captains", "capitaines")}
        </span>
      </div>
      <span className="muted" style={{ fontSize: "0.72rem" }}>
        {t("Time from one square falling to the next.", "Temps entre deux cases prises.")}
      </span>
      <div style={{ overflowX: "auto", maxHeight: "26rem", overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
          <SortHeader columns={columns} sort={sort} direction={direction} onSort={sortBy} leading="#" />
          <tbody>
            {sorted.map((r, i) => {
              const num = { padding: "0.2rem 0.4rem", fontVariantNumeric: "tabular-nums" as const };
              const p = profiles.get(r.key);
              return (
                <tr key={r.key} style={{ textAlign: "right", borderTop: "1px solid var(--panel-border)" }}>
                  <td style={{ textAlign: "left", padding: "0.2rem 0.4rem", color: "var(--text-dim)" }}>{i + 1}</td>
                  <td style={{ textAlign: "left", padding: "0.2rem 0.4rem" }}>
                    {/* Carries the set through, so a captain's page shows the same board's numbers
                        as the row that was clicked to reach it. */}
                    <Link
                      to={`/player/${encodeURIComponent(r.key)}?set=${encodeURIComponent(setId)}`}
                      style={{ display: "flex", alignItems: "center", gap: "0.4rem", textDecoration: "none", color: "var(--text)" }}
                    >
                      {p?.avatar_url && (
                        <img src={p.avatar_url} alt="" width={18} height={18} style={{ borderRadius: "50%" }} />
                      )}
                      <span>{profileName(p) ?? r.nickname}</span>
                    </Link>
                  </td>
                  <td style={num}>{r.matches}</td>
                  <td style={num}>{r.shots}</td>
                  <td style={{ ...num, color: r.median === null ? "var(--text-dim)" : undefined }}>
                    {r.median !== null ? fmt(r.median) : "-"}
                  </td>
                  <td style={num}>{fmt(r.secondsPerShot)}</td>
                  <td style={num}>
                    {r.bestMatch ? (
                      <Link to={`/match/${encodeURIComponent(r.bestMatch.matchKey)}`} style={{ textDecoration: "none" }}>
                        {fmt(r.bestMatch.seconds)}
                      </Link>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span className="muted" style={{ fontSize: "0.7rem" }}>
        {t(
          `A median needs ${MIN_GAPS_FOR_PACE} squares before it shows; the average appears from the first match. Guests are grouped by nickname, so two people using the same name share a row.`,
          `Une médiane nécessite ${MIN_GAPS_FOR_PACE} cases avant de s'afficher ; la moyenne apparaît dès la première partie. Les invités sont regroupés par pseudo, donc deux personnes utilisant le même nom partagent une ligne.`,
        )}
      </span>
    </div>
  );
}
