import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BoardGrid, type CellVisual, type ShipOverlay } from "../components/BoardGrid";
import { TheDeep } from "../components/TheDeep";
import { challengesForRoom, squareSet, type Region } from "../lib/challenges";
import type { DeepMark } from "../lib/deepWater";
import {
  fetchArchivedMatch,
  archivedBoardSize,
  archivedBoardSource,
  archivedDeep,
  archivedBalance,
  archivedSquareSet,
  archivedTeams,
  type ArchivedMatchDetail,
} from "../lib/matchArchive";
import { teamName, teamHex } from "../lib/teamColors";
import { useLanguage, useT } from "../lib/language";
import { formatRoomCode } from "../lib/roomCode";
import { matchEpithet } from "../lib/matchName";
import { paceLabel } from "../lib/squarePace";
import { buildReplay } from "../lib/replay";
import { MatchReplay } from "../components/MatchReplay";
import { BalanceReadout } from "../components/BalanceReadout";
import { BrandMark, LoadingScreen } from "../components/BrandMark";
import { SiteFooter } from "../components/SiteFooter";

/**
 * The recap of a match that finished long ago.
 *
 * A rebuild of the post-match screen from the archive tables rather than a saved copy of it: the
 * room it was played in was pruned within the hour, so `rooms`, `fleets` and `attacks` are all
 * gone. What survives is match_reports (the header, scoreboard, honors, and what the water gave
 * up), match_fleets (where every ship sat) and match_events (every shot). That is enough to draw
 * the same two boards.
 *
 * The finds are the one part that can be missing rather than merely old. They were not archived at
 * all until recently - `deep_hides` went with the room, so a recap could name the Flying Dutchman in
 * its honors and draw a board with nothing on it. Matches from before that read their own honors for
 * the squares those happen to name, and say so.
 *
 * Reachable from the Almanac, and by URL - these pages are permanent and shareable, which is the
 * point of them.
 */
export function ArchivedMatch() {
  const { key } = useParams<{ key: string }>();
  const matchKey = key ? decodeURIComponent(key) : "";
  const [detail, setDetail] = useState<ArchivedMatchDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const lang = useLanguage();
  const t = useT();

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setFailed(false);
    void (async () => {
      try {
        const d = await fetchArchivedMatch(matchKey);
        if (!cancelled) setDetail(d);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [matchKey]);

  const boardSize = detail ? archivedBoardSize(detail) : 10;
  const source = detail ? archivedBoardSource(detail) : { roomId: null, seed: null, perm: null };
  const setId = detail ? archivedSquareSet(detail) : null;

  /**
   * The squares this match was played on.
   *
   * Rebuilt from the room id, set, seed and balanced layout - the same four inputs the live board
   * used - so a recap names the squares that were actually on screen. Matches archived before those
   * columns existed have no room id, and fall back below to naming only what was fired at.
   */
  const challenges = useMemo(
    () =>
      source.roomId
        ? challengesForRoom(source.roomId, boardSize * boardSize, setId, source.seed, source.perm)
        : null,
    [source.roomId, source.seed, source.perm, boardSize, setId]
  );

  /**
   * The playable version of this match.
   *
   * Built from the same two tables the boards below are drawn from, so it costs no extra fetch -
   * the fleets say where the hulls were, the events say what was fired at and when, and folding one
   * over the other gives every board the match ever had. Null only when nothing was archived.
   */
  const replay = useMemo(
    () => (detail ? buildReplay(detail.fleets, detail.events) : null),
    [detail]
  );

  /**
   * What this match turned up in the water (see lib/deepWater.ts).
   *
   * Read out of the archived report, which has carried every find since archiveMatch started writing
   * them down. Older matches fall back to whatever the honors happen to name - the hiding places
   * themselves went with the room - and `salvaged` says so on the page rather than presenting a
   * partial list as the whole story.
   */
  const deep = useMemo(() => (detail ? archivedDeep(detail) : null), [detail]);

  /** How fair this board was, as the balancer recorded it - see lib/matchBalance. */
  const balance = useMemo(() => (detail ? archivedBalance(detail) : null), [detail]);

  /** The same finds keyed by square, which is what the boards below draw from. */
  const deepByCell = useMemo(
    () => new Map<number, DeepMark>((deep?.finds ?? []).map((f) => [f.cellIndex, f.mark])),
    [deep]
  );

  /** Cell -> square name for matches that can't be reconstructed: only the shots left a record. */
  const firedNames = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of detail?.events ?? []) {
      if (e.challenge_name) m.set(e.cell_index, e.challenge_name);
    }
    return m;
  }, [detail]);

  if (failed) return <p className="error-text">{t("Couldn't load that match.", "Impossible de charger ce match.")}</p>;
  if (!detail) return <LoadingScreen>{t("Loading match...", "Chargement du match...")}</LoadingScreen>;

  const { report, fleets, events } = detail;
  if (!report && fleets.length === 0 && events.length === 0) {
    return (
      <div className="stack" style={{ alignItems: "center", gap: "0.8rem" }}>
        <p className="muted">{t("Nothing on record under that key.", "Rien d'enregistré sous cette clé.")}</p>
        <Link to="/almanac">{t("Back to the Almanac", "Retour à l'almanach")}</Link>
      </div>
    );
  }

  const teams = archivedTeams(detail);
  const stats = report?.summary?.stats ?? [];
  const awards = report?.summary?.awards ?? [];
  const shipDefs = fleets.find((f) => f.ship_defs?.length)?.ship_defs ?? [];

  /**
   * What happened to each cell on a given team's board, from the shots fired at them.
   *
   * Exact for a two-fleet match, which is nearly all of them. With three or more, it is the best
   * available reading rather than the truth: match_events stores one row per trigger-pull with the
   * result collapsed across every defender (`bool_or(hit or sunk)` in archive_match), so a shot
   * that hit one fleet and missed another is archived only as a hit, and shows as a hit on both
   * boards here. The per-defender detail lived in `attacks`, which was pruned with the room.
   */
  function visualFor(team: number) {
    const byCell = new Map<number, string>();
    for (const e of events) {
      if (e.team === team) continue;
      const prior = byCell.get(e.cell_index);
      // Keep the most informative outcome if two attackers hit the same square.
      if (prior === "sunk") continue;
      if (prior === "hit" && e.result === "miss") continue;
      byCell.set(e.cell_index, e.result);
    }
    return (index: number): CellVisual => {
      const r = byCell.get(index);
      if (r === "sunk") return "sunk";
      if (r === "hit") return "hit";
      if (r === "miss") return "miss";
      return "empty";
    };
  }

  /**
   * The finds one fleet's board can carry, which is not all of them.
   *
   * Same rule as the live recap: a find is one square that came back a miss against everybody, so
   * the mark is only honest on a board that recorded that square as water. A fleet already sunk when
   * something was found stopped taking rows, and drawing a sail over one of its wrecks would invent
   * open water where the board is showing a burning ship. The panel above lists every find regardless,
   * which is the other half of why both exist.
   */
  function deepCellsFor(team: number): Map<number, DeepMark> {
    const visual = visualFor(team);
    return new Map([...deepByCell].filter(([cell]) => visual(cell) === "miss"));
  }

  function shipsFor(team: number): ShipOverlay[] {
    const fleet = fleets.find((f) => f.team === team);
    const defs = fleet?.ship_defs ?? shipDefs;
    return (fleet?.placements ?? [])
      .filter((p) => defs[p.shipIndex])
      .map((p) => ({
        row: p.startRow,
        col: p.startCol,
        size: defs[p.shipIndex].size,
        horizontal: p.isHorizontal,
        shipName: defs[p.shipIndex].name,
        colorHex: teamHex(team),
      }));
  }

  function cellText(i: number): { label: string; title?: string; region?: Region; color?: string } | null {
    const c = challenges?.[i];
    if (c) {
      return {
        label: (lang === "fr" ? c.shortFr ?? c.nameFr : undefined) ?? c.short ?? c.name,
        title: (lang === "fr" ? c.titleFr : undefined) ?? c.title ?? c.name,
        region: c.region,
        color: c.color,
      };
    }
    // Fallback for matches archived before board reconstruction: only the fired squares are
    // known, by name alone, so there's no region to colour them by.
    const name = firedNames.get(i);
    return name ? { label: name, title: name } : null;
  }

  const when = report?.finished_at ? new Date(report.finished_at) : null;
  const setLabel = setId ? squareSet(setId).label : null;
  const draw = report ? report.winner_team === null : false;

  return (
    <div className="stack" style={{ alignItems: "center", width: "100%", gap: "0.9rem" }}>
      <div className="panel stack" style={{ alignItems: "center", textAlign: "center", gap: "0.3rem" }}>
        {/* Same treatment as the live recap in MatchReport, so a permalink opened by someone who
            has never seen the site lands on something that identifies itself. This is the page
            those shared links actually resolve to. */}
        <BrandMark width="9rem" />
        {/* The match's name, which already contains the room code - see lib/matchName. The outcome
            moves down to the line below, where it reads as a fact about the match rather than as its
            title: "Blue Wins" was the same heading on every page. */}
        <h1 style={{ margin: 0 }}>
          {report
            ? matchEpithet({
                roomCode: report.room_code,
                winnerTeam: report.winner_team,
                duration: report.duration,
                totalShots: report.total_shots,
                stats: report.summary?.stats ?? [],
                awards: report.summary?.awards ?? [],
              })
            : t("Match record", "Fiche du match")}
        </h1>
        <span className="muted">
          {report
            ? draw
              ? `${t("Mutual destruction", "Destruction mutuelle")} · `
              : `${teamName(report.winner_team ?? 0)} ${t("won", "a gagné")} · `
            : ""}
          {t("Room", "Salle")} {formatRoomCode(report?.room_code ?? matchKey.split(":")[0] ?? "")}
          {when ? ` · ${when.toLocaleDateString()} ${when.toLocaleTimeString()}` : ""}
          {setLabel ? ` · ${setLabel}` : ""}
        </span>
        {report && (
          <span className="muted">
            {t("Match time", "Durée du match")} {report.duration ?? t("unknown", "inconnue")} ·{" "}
            {report.total_shots} {t("shots fired", "tirs effectués")}
          </span>
        )}
        {/* Why a voided match still has a page at all, said on the page itself.

            The match is not hidden and not deleted - it is here, complete, and it counts for
            nothing. Without this line a captain who opens it and then cannot find a single one of
            its squares anywhere in their own record has no way to find out why, and the natural
            reading of that is that the site lost them. Six words do that job. The line used to
            spend two more sentences telling the reader not to hoard shots, which is a rule the
            room already enforces and a scolding nobody opened a recap to read. */}
        {/* Both flags are true on a practice match - `practice` sets `voided` at archive time,
            because voided is what the stats readers actually filter on. Only one line is printed,
            and it is this one: "Voided" on a match nobody ever entered into the record would be an
            accusation where there is nothing to accuse. */}
        {report?.practice ? (
          <span style={{ color: "var(--hit)", fontSize: "0.82rem", maxWidth: "34rem" }}>
            <strong>{t("Practice match", "Match d'entraînement")}</strong> -{" "}
            {t(
              "declared before it was played, archived in full, counted in nothing.",
              "déclaré avant d'être joué, archivé en entier, mais ne compte pour rien."
            )}
          </span>
        ) : (
          report?.voided && (
            <span style={{ color: "var(--danger)", fontSize: "0.82rem", maxWidth: "34rem" }}>
              <strong>{t("Voided", "Annulé")}</strong> -{" "}
              {t("archived in full, counted in nothing.", "archivé en entier, mais ne compte pour rien.")}
            </span>
          )
        )}
      </div>

      {awards.length > 0 && (
        <div className="panel stack" style={{ gap: "0.5rem", width: "min(560px, 100%)" }}>
          <h3 style={{ margin: 0 }}>{t("Honors", "Honneurs")}</h3>
          {awards.map((a) => (
            <div key={a.title} className="row" style={{ gap: "0.6rem", alignItems: "baseline" }}>
              <span style={{ fontSize: "1.2rem" }}>{a.emoji}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong className="display" style={{ color: "var(--accent)" }}>
                  {a.title}
                </strong>
                <span className="muted"> - </span>
                <strong>{a.nickname}</strong>
                <div className="muted" style={{ fontSize: "0.76rem" }}>{a.detail}</div>
              </span>
            </div>
          ))}
        </div>
      )}

      {stats.length > 0 && (
        <div className="panel stack" style={{ gap: "0.5rem", width: "min(560px, 100%)" }}>
          <h3 style={{ margin: 0 }}>{t("Scoreboard", "Tableau des scores")}</h3>
          {[...new Set(stats.map((s) => s.team))]
            .sort((a, b) => a - b)
            .map((team) => (
              <div key={team} className="stack" style={{ gap: "0.2rem" }}>
                <strong style={{ color: teamHex(team), fontSize: "0.9rem" }}>{teamName(team)}</strong>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                    <thead>
                      <tr style={{ color: "var(--text-dim)", textAlign: "right" }}>
                        <th style={{ textAlign: "left", fontWeight: 500, padding: "0.15rem 0.4rem" }}>{t("Player", "Joueur")}</th>
                        <th style={{ fontWeight: 500, padding: "0.15rem 0.4rem" }}>{t("Shots", "Tirs")}</th>
                        <th style={{ fontWeight: 500, padding: "0.15rem 0.4rem" }}>{t("Hits", "Touchés")}</th>
                        <th style={{ fontWeight: 500, padding: "0.15rem 0.4rem" }}>{t("Miss", "Ratés")}</th>
                        <th style={{ fontWeight: 500, padding: "0.15rem 0.4rem" }}>{t("Sunk", "Coulés")}</th>
                        <th style={{ fontWeight: 500, padding: "0.15rem 0.4rem" }}>{t("Acc.", "Préc.")}</th>
                        <th
                          style={{ fontWeight: 500, padding: "0.15rem 0.4rem" }}
                          title={t(
                            "Their typical square, start to finish: the median gap between their shots.",
                            "Leur case habituelle, du début à la fin : l'écart médian entre leurs tirs."
                          )}
                        >
                          {t("Pace", "Rythme")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats
                        .filter((s) => s.team === team)
                        .map((s) => (
                          <tr key={s.nickname} style={{ textAlign: "right" }}>
                            <td style={{ textAlign: "left", padding: "0.15rem 0.4rem" }}>{s.nickname}</td>
                            <td style={{ padding: "0.15rem 0.4rem", fontVariantNumeric: "tabular-nums" }}>{s.shots}</td>
                            <td style={{ padding: "0.15rem 0.4rem", fontVariantNumeric: "tabular-nums", color: "var(--hit)" }}>
                              {s.hits}
                            </td>
                            <td style={{ padding: "0.15rem 0.4rem", fontVariantNumeric: "tabular-nums", color: "var(--text-dim)" }}>
                              {s.misses}
                            </td>
                            <td style={{ padding: "0.15rem 0.4rem", fontVariantNumeric: "tabular-nums", color: "var(--sunk)" }}>
                              {s.sunk}
                            </td>
                            <td style={{ padding: "0.15rem 0.4rem", fontVariantNumeric: "tabular-nums" }}>
                              {Math.round((s.accuracy ?? 0) * 100)}%
                            </td>
                            {/* Every match filed before pace joined the scoreboard shows a dash
                                here: the gaps it is measured from were never stored, only the
                                tallies, so there is nothing to work it out from after the fact. */}
                            <td style={{ padding: "0.15rem 0.4rem", fontVariantNumeric: "tabular-nums" }}>
                              {s.pace != null ? paceLabel(s.pace) : "-"}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
        </div>
      )}

      {deep && (
        <div className="stack" style={{ alignItems: "center", gap: "0.3rem", width: "min(560px, 100%)" }}>
          <TheDeep entries={deep.finds} boardSize={boardSize} cthulhu={deep.cthulhu} />
          {deep.salvaged && deep.finds.length > 0 && (
            <span className="muted" style={{ fontSize: "0.78rem" }}>
              {t(
                "Older than the Deep Water records. These are the finds its honors named; there may have been more.",
                "Antérieur aux registres des Profondeurs. Voici les découvertes que ses honneurs nomment ; il pourrait y en avoir eu d'autres."
              )}
            </span>
          )}
        </div>
      )}

      <BalanceReadout balance={balance} />

      <div className="stack" style={{ alignItems: "center", gap: "0.4rem", width: "100%" }}>
        {/* The replay opens on the final board, so this is still the same recap it always was -
            with the whole match behind the scrubber. Matches with no shots archived keep the
            static boards, which is all they can support. */}
        {replay ? (
          <MatchReplay replay={replay} cellText={cellText} deepCells={deepByCell} />
        ) : teams.length === 0 ? (
          <>
            <h3 style={{ margin: 0 }}>{t("Final fleets", "Flottes finales")}</h3>
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              {t("No boards on record for this match.", "Aucun plateau enregistré pour ce match.")}
            </span>
          </>
        ) : (
          <>
            <h3 style={{ margin: 0 }}>{t("Final fleets", "Flottes finales")}</h3>
            <div className="row" style={{ gap: "1.5rem", flexWrap: "wrap", justifyContent: "center", alignItems: "flex-start" }}>
              {teams.map((team) => (
                <BoardGrid
                  key={team}
                  boardSize={boardSize}
                  cellVisual={visualFor(team)}
                  label={teamName(team)}
                  ships={shipsFor(team)}
                  deepCells={deepCellsFor(team)}
                  maxVh={52}
                  maxVw={42}
                  cellText={cellText}
                />
              ))}
            </div>
          </>
        )}
        {!challenges && (
          <span className="muted" style={{ fontSize: "0.78rem" }}>
            {t(
              "Older than the board records. Only the squares somebody fired at are named.",
              "Antérieur aux registres du plateau. Seules les cases visées sont nommées."
            )}
          </span>
        )}
      </div>

      {report?.report_text && (
        <details className="panel" style={{ width: "min(560px, 100%)" }}>
          <summary style={{ cursor: "pointer" }}>{t("Text report", "Rapport texte")}</summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.78rem", margin: "0.6rem 0 0" }}>
            {report.report_text}
          </pre>
        </details>
      )}

      <Link to="/almanac">{t("Back to the Almanac", "Retour à l'almanach")}</Link>
      <SiteFooter />
    </div>
  );
}
