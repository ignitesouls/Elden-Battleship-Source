import { useEffect, useMemo, useRef, useState } from "react";
import { BoardGrid } from "../components/BoardGrid";
import { TheDeep, type DeepEntry } from "./TheDeep";
import { igonAnchor } from "../lib/challenges";
import { finalFinds, bottleNote, type DeepHide } from "../lib/deepWater";
import { buildMatchReport, formatReportText } from "../lib/matchReport";
import { archiveMatch } from "../lib/archiveMatch";
import { teamName } from "../lib/teamColors";
import { useT } from "../lib/language";
import { fetchArchivedPlacements, RecapHonors, RecapScoreboard, useRecapBoards } from "./RecapParts";
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
  const t = useT();
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
    () => buildMatchReport(room, players, attacks, deepHides, igonAnchor(room)),
    [room, players, attacks, deepHides]
  );
  const boardSize = room.board_size;
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
      const placements = await fetchArchivedPlacements(room.id);
      if (placements) setArchivedPlacements(placements);
    })();
  }, [room, players, attacks, fleets, deepHides]);

  function copy() {
    navigator.clipboard?.writeText(formatReportText(report, attacks, boardSize));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  /** The archive first, since it is the only source guaranteed to hold every team. */
  function placementsFor(team: number): ShipPlacement[] {
    const archived = archivedPlacements?.get(team);
    if (archived && archived.length > 0) return archived;
    return fleets.find((f) => f.team === team)?.placements ?? [];
  }

  // Each fleet's final board, drawn by the same code the stream's recap uses - see RecapParts.
  const { boardFor } = useRecapBoards(room, attacks, report, activeTeamsList, placementsFor);

  // Judged per team rather than on `fleets.length`, which was the bug: a player could read their
  // own fleet row and nobody else's, so the list was non-empty, the boards rendered, and only the
  // opponent's came out shipless with nothing on screen to say why.
  const teamsWithShips = activeTeamsList.filter((t) => placementsFor(t).length > 0);
  const fleetsHidden = teamsWithShips.length === 0;
  const fleetsPartial = !fleetsHidden && teamsWithShips.length < activeTeamsList.length;

  return (
    <div className="stack" style={{ alignItems: "center", width: "100%", gap: "0.9rem" }}>
      <div className="panel stack" style={{ alignItems: "center", textAlign: "center", gap: "0.3rem" }}>
        {/* This panel is the screenshot: the recap is what gets posted to Discord after a
            tournament match, and until now it left the frame with nothing on it saying where the
            result came from. Above the result rather than beside it, so a crop taken around the
            winner's name still catches it. */}
        <BrandMark width="9rem" />
        <h1 style={{ margin: 0 }}>
          {report.draw
            ? t("Mutual Destruction", "Destruction mutuelle")
            : `${teamName(report.winnerTeam ?? 0)} ${t("Wins", "gagne")}`}
        </h1>
        <span className="muted">
          {t("Match time", "Durée du match")} {report.duration} · {report.totalShots} {t("shots fired", "tirs effectués")}
        </span>
        {/* Inside the screenshot panel on purpose. This recap is what gets posted to Discord after a
            match, and a practice run posted without the label is a result somebody will read as
            real - then go looking for on the leaderboard. */}
        {room.practice && (
          <span style={{ color: "var(--hit)", fontSize: "0.82rem" }}>
            <strong>{t("Practice match", "Match d'entraînement")}</strong> - {t("saved in full, counted in nothing.", "enregistré en entier, mais ne compte pour rien.")}
          </span>
        )}
      </div>

      {report.awards.length > 0 && (
        <div className="panel stack" style={{ gap: "0.5rem", width: "min(560px, 100%)" }}>
          <RecapHonors awards={report.awards} />
        </div>
      )}

      <div className="panel stack" style={{ gap: "0.5rem", width: "min(560px, 100%)" }}>
        <RecapScoreboard report={report} />
      </div>

      {/* Text, not a glyph - matching the toolbar. */}
      <button onClick={copy} className="primary">
        {copied ? t("Copied to clipboard!", "Copié dans le presse-papiers !") : t("Copy match report", "Copier le rapport de match")}
      </button>

      {/* Between the scoreboard and the boards, which is where the question comes up: the
          scoreboard says who won, the boards are about to show what they were shooting at, and this
          is whether the two sides were shooting at comparable work. Read straight off the room -
          balance-board wrote it there before the first shot, so it needs no archive round trip. */}
      <BalanceReadout balance={asMatchBalance(room.balance_report)} />

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
        <h3 style={{ margin: 0 }}>{t("Final fleets", "Flottes finales")}</h3>
        {fleetsHidden ? (
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            {t("No ship positions on record for this match.", "Aucune position de navire enregistrée pour ce match.")}
          </span>
        ) : (
          <div className="row" style={{ gap: "1.5rem", flexWrap: "wrap", justifyContent: "center", alignItems: "flex-start" }}>
            {activeTeamsList.map((team) => (
              <BoardGrid key={team} {...boardFor(team)} maxVh={52} maxVw={42} />
            ))}
          </div>
        )}
        {fleetsPartial && (
          <span className="muted" style={{ fontSize: "0.78rem" }}>
            {t("Some fleets couldn't be read back. Those boards show shots only.", "Certaines flottes n'ont pas pu être relues. Ces plateaux n'affichent que les tirs.")}
          </span>
        )}
      </div>
    </div>
  );
}
