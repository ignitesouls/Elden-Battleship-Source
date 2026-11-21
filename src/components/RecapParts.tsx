import { useMemo } from "react";
import { type CellVisual, type ShipOverlay } from "./BoardGrid";
import { sunkCellOrientations } from "../lib/battleshipLogic";
import { cellVisuals } from "../lib/cellVisuals";
import { challengesForRoom } from "../lib/challenges";
import { finalMarks, type DeepMark } from "../lib/deepWater";
import { type MatchReport } from "../lib/matchReport";
import { paceLabel } from "../lib/squarePace";
import { supabase } from "../lib/supabase";
import { teamName, teamHex } from "../lib/teamColors";
import { useLanguage, useT } from "../lib/language";
import type { Attack, Room, ShipPlacement } from "../types/battleship";

/**
 * The pieces of the post-match recap, shared by the two places that draw one.
 *
 * components/MatchReport is the recap a player sees, and it also ARCHIVES the match - reaching it is
 * what defines a match as finished. The board browser source shows the same recap on stream when a
 * match ends (see components/OverlayRecap), and must never archive anything: it belongs to no player
 * and has no business writing the record. So the drawing lives here and the archiving stays there,
 * and the stream and the player's screen cannot drift apart over what the honors or the scoreboard say.
 */

/**
 * Every team's ships for a finished match, read back out of the archive.
 *
 * The live `fleets` table only shows a client what RLS lets it see - a player their own team, a
 * browser source nothing at all. archive_match is security definer and copies every fleet into
 * match_fleets, which is world-readable, so this is both complete and independent of who is asking.
 *
 * Keyed by room rather than match_key: the archive builds its key from a Postgres timestamp string,
 * which is not the ISO string the client has. A room is reused for rematches, so older matches' rows
 * share the room id - they are read oldest-first so each team ends up with its NEWEST row.
 */
export async function fetchArchivedPlacements(roomId: string): Promise<Map<number, ShipPlacement[]> | null> {
  const { data } = await supabase
    .from("match_fleets")
    .select("team, placements, finished_at")
    .eq("room_id", roomId)
    .order("finished_at", { ascending: true });
  if (!data) return null;
  return new Map(data.map((r) => [r.team as number, (r.placements ?? []) as ShipPlacement[]]));
}

/** The Honors list - the panel's heading and one line per award. */
export function RecapHonors({ awards }: { awards: MatchReport["awards"] }) {
  const t = useT();
  return (
    <>
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
    </>
  );
}

/** The Scoreboard - the panel's heading and one table per fleet. */
export function RecapScoreboard({ report }: { report: MatchReport }) {
  const t = useT();
  const statsByTeam = [...new Set(report.stats.map((s) => s.team))].sort((a, b) => a - b);
  return (
    <>
      <h3 style={{ margin: 0 }}>{t("Scoreboard", "Tableau des scores")}</h3>
      {statsByTeam.map((team) => (
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
                  {/* The only column here that is about how somebody PLAYS rather than how well
                      they shoot - two captains with identical aim can be an hour apart over a
                      match, and nothing else on this table would ever say so. */}
                  <th
                    style={{ fontWeight: 500, padding: "0.15rem 0.4rem" }}
                    title={t(
                      "Their typical square, start to finish: the median gap between their shots. Under fire-on-kill a shot IS a kill, so that gap is one boss.",
                      "Leur case habituelle, du début à la fin : l'écart médian entre leurs tirs. Avec le tir-sur-mise-à-mort, un tir EST une mise à mort, donc cet écart est un boss."
                    )}
                  >
                    {t("Pace", "Rythme")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.stats
                  .filter((s) => s.team === team)
                  .map((s) => (
                    <tr key={`${s.playerId ?? s.nickname}`} style={{ textAlign: "right" }}>
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
                        {Math.round(s.accuracy * 100)}%
                      </td>
                      {/* A dash rather than a number when they took too few squares for a median
                          to mean anything - and on reports archived before this column existed. */}
                      <td style={{ padding: "0.15rem 0.4rem", fontVariantNumeric: "tabular-nums" }}>
                        {s.pace != null ? paceLabel(s.pace) : "-"}
                      </td>
                    </tr>
                  ))}
                {(() => {
                  // Team totals. Accuracy is recomputed from the summed shots/hits rather than
                  // averaged across players - averaging percentages would weight someone's
                  // two lucky shots the same as a teammate's forty.
                  const roster = report.stats.filter((s) => s.team === team);
                  if (roster.length < 2) return null;
                  const totals = roster.reduce(
                    (acc, s) => ({
                      shots: acc.shots + s.shots,
                      hits: acc.hits + s.hits,
                      misses: acc.misses + s.misses,
                      sunk: acc.sunk + s.sunk,
                    }),
                    { shots: 0, hits: 0, misses: 0, sunk: 0 }
                  );
                  const cell = { padding: "0.15rem 0.4rem", fontVariantNumeric: "tabular-nums" as const };
                  return (
                    <tr style={{ textAlign: "right", borderTop: "1px solid var(--panel-border)", color: "var(--text-dim)" }}>
                      <td style={{ textAlign: "left", padding: "0.15rem 0.4rem" }}>{t("Fleet total", "Total de la flotte")}</td>
                      <td style={cell}>{totals.shots}</td>
                      <td style={cell}>{totals.hits}</td>
                      <td style={cell}>{totals.misses}</td>
                      <td style={cell}>{totals.sunk}</td>
                      <td style={cell}>{totals.shots > 0 ? Math.round((totals.hits / totals.shots) * 100) : 0}%</td>
                      {/* Deliberately empty. Accuracy totals because hits and shots add up; a
                          pace does not - a fleet's typical square is the median of everybody's
                          gaps pooled, which is neither the sum nor the average of the three
                          medians above it, and is not recoverable from them. Averaging them
                          anyway would be the same mistake this row avoids for accuracy. */}
                      <td style={cell}></td>
                    </tr>
                  );
                })()}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {report.stats.length === 0 && <span className="muted">{t("Nobody fired a shot.", "Personne n'a tiré.")}</span>}
    </>
  );
}

/**
 * Everything a fleet's final board needs, as BoardGrid props: `boardFor(team)` hands back the lot.
 *
 * `placements` is the archive's read-back (see fetchArchivedPlacements), falling back to whatever
 * live fleets the caller could see - the archive first, since it is the only source guaranteed to
 * hold every team.
 */
export function useRecapBoards(
  room: Room,
  attacks: Attack[],
  report: MatchReport,
  activeTeamsList: number[],
  placementsFor: (team: number) => ShipPlacement[]
) {
  const lang = useLanguage();
  const boardSize = room.board_size;
  const shipDefs = room.ship_defs;
  const challenges = useMemo(
    () => challengesForRoom(room.id, boardSize * boardSize, room.square_set, room.seed, room.board_perm, room.seed_set_at),
    [room.id, boardSize, room.square_set, room.seed, room.board_perm, room.seed_set_at]
  );
  const sunkCells = useMemo(() => sunkCellOrientations(attacks, boardSize), [attacks, boardSize]);
  /**
   * Everything the match turned up in the water, now that it can be told (see lib/deepWater.ts).
   *
   * `finalMarks` is the post-match policy: every find, whoever made it, and nothing that was never
   * found. During the match a crew saw only its own; here the honors already name every finder out
   * loud, so a board that still hid the squares would contradict the list printed over it.
   */
  const deepCells = useMemo(() => finalMarks(report.deep), [report.deep]);

  /**
   * Each fleet's board, resolved in one walk of the log per fleet rather than one filter of the
   * whole log per square - see lib/cellVisuals. `deepCellsFor` below reads these too.
   *
   * -- Note the sunk set this passes ---------------------------------------------------------------
   *
   * Only the square that dealt the final blow, taken from the rows themselves, rather than every
   * cell of the hull as `sunkCellOrientations` would give. That is what this board has always drawn
   * and is preserved deliberately: a fleet's own board burns the whole hull, and the spectator page
   * fixed the same discrepancy on its boards (see the note on sunkByTeam in Room.tsx), so this recap
   * is now the last place the two disagree. Changing it moves what `deepCellsFor` will carry as
   * well, which makes it a decision about the recap rather than a change of shape - so it is left
   * exactly as it was.
   */
  const visualsByTeam = useMemo(() => {
    const out = new Map<number, Map<number, CellVisual>>();
    for (const team of activeTeamsList) {
      const rows = attacks.filter((a) => a.defender_team === team);
      const killing = new Set(rows.filter((a) => a.result === "sunk").map((a) => a.cell_index));
      out.set(team, cellVisuals(rows, killing));
    }
    return out;
  }, [attacks, activeTeamsList]);

  function visualFor(team: number) {
    const visuals = visualsByTeam.get(team);
    return (index: number): CellVisual => visuals?.get(index) ?? "empty";
  }

  /**
   * The finds to draw on ONE fleet's board, which is not all of them.
   *
   * A find belongs to the room rather than to any single fleet - it is one square that came back a
   * miss against everyone still afloat - but these boards are per-defender, so the mark is only
   * honest on a board that actually recorded the square as water. Restricting it to `miss` squares
   * is what keeps a tentacle found at minute nine off the board of a fleet that sank at minute four:
   * that fleet stopped taking rows, its hulls are all wrecks by then, and drawing an arm on top of
   * one would invent a square of open water where the recap is showing a burning ship.
   *
   * Nothing is lost by it. The Deep panel lists every find with its square regardless of which
   * boards can carry it, which is the other half of why both exist.
   */
  function deepCellsFor(team: number): Map<number, DeepMark> {
    const visual = visualFor(team);
    return new Map([...deepCells].filter(([cell]) => visual(cell) === "miss"));
  }

  function shipsFor(team: number): ShipOverlay[] {
    return placementsFor(team).map((p) => ({
      row: p.startRow,
      col: p.startCol,
      size: shipDefs[p.shipIndex].size,
      horizontal: p.isHorizontal,
      shipName: shipDefs[p.shipIndex].name,
      colorHex: teamHex(team),
    }));
  }

  // The recap used to show bare colored squares, which made it impossible to say what anybody
  // actually took - the whole point of reading a board back.
  const cellText = (i: number) => {
    const c = challenges[i];
    if (!c) return null;
    return {
      label: (lang === "fr" ? c.shortFr ?? c.nameFr : undefined) ?? c.short ?? c.name,
      title: (lang === "fr" ? c.titleFr : undefined) ?? c.title ?? c.name,
      region: c.region,
      color: c.color,
    };
  };

  function boardFor(team: number) {
    return {
      boardSize,
      cellVisual: visualFor(team),
      label: teamName(team),
      ships: shipsFor(team),
      sunkOrientation: sunkCells,
      deepCells: deepCellsFor(team),
      cellText,
    };
  }

  return { boardFor };
}
