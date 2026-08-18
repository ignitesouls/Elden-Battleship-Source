import { useEffect, useMemo, useRef, useState } from "react";
import { BoardGrid, type CellVisual, type ShipOverlay } from "../components/BoardGrid";
import { TheDeep, type DeepEntry } from "./TheDeep";
import { sunkCellOrientations } from "../lib/battleshipLogic";
import { cellVisuals } from "../lib/cellVisuals";
import { challengesForRoom } from "../lib/challenges";
import { finalFinds, finalMarks, bottleNote, type DeepHide, type DeepMark } from "../lib/deepWater";
import { buildMatchReport, formatReportText } from "../lib/matchReport";
import { archiveMatch } from "../lib/archiveMatch";
import { supabase } from "../lib/supabase";
import { teamName, teamHex } from "../lib/teamColors";
import { BrandMark } from "./BrandMark";
import { BalanceReadout } from "./BalanceReadout";
import { asMatchBalance } from "../lib/matchBalance";
import type { Attack, Fleet, Player, Room, ShipPlacement } from "../types/battleship";

interface Props {
  room: Room;
  players: Player[];
  attacks: Attack[];
  /** Every hiding place the match uncovered - see lib/deepWater.ts. */
  deepHides: DeepHide[];
  fleets: Fleet[];
  activeTeamsList: number[];
}

export function MatchReport({ room, players, attacks, deepHides, fleets, activeTeamsList }: Props) {
  const [copied, setCopied] = useState(false);
  /**
   * Every team's ships, read back out of the archive.
   *
   * The live `fleets` table can only ever show this client what RLS lets it see, which for a
   * player is their OWN team unless the post-match reveal policy is in place - so the recap drew
   * your ships and left the opponent's board as bare shot markers. archive_match is security
   * definer and copies all fleets into match_fleets, which is world-readable, so reading them
   * back is both complete and independent of which policies happen to be applied.
   */
  const [archivedPlacements, setArchivedPlacements] = useState<Map<number, ShipPlacement[]> | null>(null);

  const report = useMemo(
    () => buildMatchReport(room, players, attacks, deepHides),
    [room, players, attacks, deepHides]
  );
  const boardSize = room.board_size;
  const challenges = useMemo(
    () => challengesForRoom(room.id, boardSize * boardSize, room.square_set, room.seed, room.board_perm),
    [room.id, boardSize, room.square_set, room.seed, room.board_perm]
  );
  const shipDefs = room.ship_defs;
  const sunkCells = useMemo(() => sunkCellOrientations(attacks, boardSize), [attacks, boardSize]);
  /**
   * Everything the match turned up in the water, now that it can be told (see lib/deepWater.ts).
   *
   * `finalMarks` is the post-match policy: every find, whoever made it, and nothing that was never
   * found. During the match a crew saw only its own; here the honors above already name every finder
   * out loud, so a board that still hid the squares would contradict the list printed over it.
   */
  const deepCells = useMemo(() => finalMarks(report.deep), [report.deep]);
  /**
   * The same finds as a list, for the panel above the boards.
   *
   * The note is looked up here rather than carried by the find, because it is a property of the
   * BOTTLE and exists whether or not anybody ever fished that one out.
   */
  const deepEntries = useMemo<DeepEntry[]>(
    () =>
      finalFinds(report.deep).map(({ find, mark }) => ({
        cellIndex: find.cellIndex,
        mark,
        who: find.who,
        attackerTeam: find.attackerTeam,
        note: mark === "bottle" ? bottleNote(room, find.cellIndex) : null,
      })),
    [report.deep, room]
  );

  // Archive the completed match, once. Reaching this screen is what defines a match as finished
  // and therefore worth recording - a match abandoned via "End match" never renders this
  // component, which is exactly how aborted games stay out of the record books.
  //
  // Every client in the room fires this simultaneously; every write dedupes on a natural key,
  // so they collapse into one set of rows.
  const savedRef = useRef(false);
  useEffect(() => {
    if (savedRef.current) return;
    savedRef.current = true;
    void (async () => {
      try {
        await archiveMatch(room, players, attacks, fleets, deepHides);
      } catch {
        // archiveMatch already logs; a failed archive must not cost us the ships below, which
        // may well have been written by another client in the room anyway.
      }
      const { data } = await supabase
        .from("match_fleets")
        .select("team, placements")
        .eq("room_id", room.id);
      if (data) {
        setArchivedPlacements(
          new Map(data.map((r) => [r.team as number, (r.placements ?? []) as ShipPlacement[]]))
        );
      }
    })();
  }, [room, players, attacks, fleets, deepHides]);

  function copy() {
    navigator.clipboard?.writeText(formatReportText(report, attacks, boardSize));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  /**
   * Each fleet's board, resolved in one walk of the log per fleet rather than one filter of the
   * whole log per square - see lib/cellVisuals. `deepCellsFor` below reads these too, and used to
   * re-filter the log once per find on top of that.
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
   * Nothing is lost by it. The Deep panel above lists every find with its square regardless of which
   * boards can carry it, which is the other half of why both exist.
   */
  function deepCellsFor(team: number): Map<number, DeepMark> {
    const visual = visualFor(team);
    return new Map([...deepCells].filter(([cell]) => visual(cell) === "miss"));
  }

  /** The archive first, since it is the only source guaranteed to hold every team. */
  function placementsFor(team: number): ShipPlacement[] {
    const archived = archivedPlacements?.get(team);
    if (archived && archived.length > 0) return archived;
    return fleets.find((f) => f.team === team)?.placements ?? [];
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

  // Judged per team rather than on `fleets.length`, which was the bug: a player could read their
  // own fleet row and nobody else's, so the list was non-empty, the boards rendered, and only the
  // opponent's came out shipless with nothing on screen to say why.
  const teamsWithShips = activeTeamsList.filter((t) => placementsFor(t).length > 0);
  const fleetsHidden = teamsWithShips.length === 0;
  const fleetsPartial = !fleetsHidden && teamsWithShips.length < activeTeamsList.length;
  const statsByTeam = [...new Set(report.stats.map((s) => s.team))].sort((a, b) => a - b);

  return (
    <div className="stack" style={{ alignItems: "center", width: "100%", gap: "0.9rem" }}>
      <div className="panel stack" style={{ alignItems: "center", textAlign: "center", gap: "0.3rem" }}>
        {/* This panel is the screenshot: the recap is what gets posted to Discord after a
            tournament match, and until now it left the frame with nothing on it saying where the
            result came from. Above the result rather than beside it, so a crop taken around the
            winner's name still catches it. */}
        <BrandMark width="9rem" />
        <h1 style={{ margin: 0 }}>
          {report.draw ? "Mutual Destruction" : `${teamName(report.winnerTeam ?? 0)} Wins`}
        </h1>
        <span className="muted">
          Match time {report.duration} · {report.totalShots} shots fired
        </span>
      </div>

      {report.awards.length > 0 && (
        <div className="panel stack" style={{ gap: "0.5rem", width: "min(560px, 100%)" }}>
          <h3 style={{ margin: 0 }}>Honors</h3>
          {report.awards.map((a) => (
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

      <div className="panel stack" style={{ gap: "0.5rem", width: "min(560px, 100%)" }}>
        <h3 style={{ margin: 0 }}>Scoreboard</h3>
        {statsByTeam.map((team) => (
          <div key={team} className="stack" style={{ gap: "0.2rem" }}>
            <strong style={{ color: teamHex(team), fontSize: "0.9rem" }}>{teamName(team)}</strong>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                <thead>
                  <tr style={{ color: "var(--text-dim)", textAlign: "right" }}>
                    <th style={{ textAlign: "left", fontWeight: 500, padding: "0.15rem 0.4rem" }}>Player</th>
                    <th style={{ fontWeight: 500, padding: "0.15rem 0.4rem" }}>Shots</th>
                    <th style={{ fontWeight: 500, padding: "0.15rem 0.4rem" }}>Hits</th>
                    <th style={{ fontWeight: 500, padding: "0.15rem 0.4rem" }}>Miss</th>
                    <th style={{ fontWeight: 500, padding: "0.15rem 0.4rem" }}>Sunk</th>
                    <th style={{ fontWeight: 500, padding: "0.15rem 0.4rem" }}>Acc.</th>
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
                      </tr>
                    ))}
                  {(() => {
                    // Team totals. Accuracy is recomputed from the summed shots/hits rather than
                    // averaged across players - averaging percentages would weight someone's
                    // two lucky shots the same as a teammate's forty.
                    const roster = report.stats.filter((s) => s.team === team);
                    if (roster.length < 2) return null;
                    const t = roster.reduce(
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
                        <td style={{ textAlign: "left", padding: "0.15rem 0.4rem" }}>Fleet total</td>
                        <td style={cell}>{t.shots}</td>
                        <td style={cell}>{t.hits}</td>
                        <td style={cell}>{t.misses}</td>
                        <td style={cell}>{t.sunk}</td>
                        <td style={cell}>{t.shots > 0 ? Math.round((t.hits / t.shots) * 100) : 0}%</td>
                      </tr>
                    );
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        {report.stats.length === 0 && <span className="muted">No shots were fired.</span>}
      </div>

      {/* Text, not a glyph - matching the toolbar. */}
      <button onClick={copy} className="primary">
        {copied ? "Copied to clipboard!" : "Copy match report"}
      </button>

      {/* Between the scoreboard and the boards, which is where the question comes up: the
          scoreboard says who won, the boards are about to show what they were shooting at, and this
          is whether the two sides were shooting at comparable work. Read straight off the room -
          balance-board wrote it there before the first shot, so it needs no archive round trip. */}
      <BalanceReadout balance={asMatchBalance(room.balance_report)} duration={report.duration} />

      <TheDeep
        entries={deepEntries}
        boardSize={boardSize}
        cthulhu={{
          found: report.deep.cthulhu.tentacles.length,
          needed: report.deep.cthulhu.needed,
          awake: report.deep.cthulhu.awake,
        }}
      />

      <div className="stack" style={{ alignItems: "center", gap: "0.4rem", width: "100%" }}>
        <h3 style={{ margin: 0 }}>Final fleets</h3>
        {fleetsHidden ? (
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            Ship positions unavailable - this match may not have been archived.
          </span>
        ) : (
          <div className="row" style={{ gap: "1.5rem", flexWrap: "wrap", justifyContent: "center", alignItems: "flex-start" }}>
            {activeTeamsList.map((team) => (
              <BoardGrid
                key={team}
                boardSize={boardSize}
                cellVisual={visualFor(team)}
                label={teamName(team)}
                ships={shipsFor(team)}
                sunkOrientation={sunkCells}
                deepCells={deepCellsFor(team)}
                maxVh={52}
                maxVw={42}
                // The recap used to show bare colored squares, which made it impossible to say
                // what anybody actually took - the whole point of reading a board back.
                cellText={(i) => {
                  const c = challenges[i];
                  if (!c) return null;
                  return {
                    label: c.short ?? c.name,
                    title: c.title ?? c.name,
                    region: c.region,
                    color: c.color,
                  };
                }}
              />
            ))}
          </div>
        )}
        {fleetsPartial && (
          <span className="muted" style={{ fontSize: "0.78rem" }}>
            Some fleets couldn't be read back - those boards show shot results only.
          </span>
        )}
      </div>
    </div>
  );
}
