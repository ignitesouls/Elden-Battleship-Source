import { useEffect, useMemo, useState } from "react";
import { BoardGrid } from "./BoardGrid";
import { BrandMark } from "./BrandMark";
import { fetchArchivedPlacements, RecapHonors, RecapScoreboard, useRecapBoards } from "./RecapParts";
import { useBoxSize } from "../hooks/useBoxSize";
import { fitScale } from "../lib/overlayFit";
import { igonAnchor } from "../lib/challenges";
import { buildMatchReport } from "../lib/matchReport";
import { teamName, teamHex } from "../lib/teamColors";
import { useT } from "../lib/language";
import type { DeepHide } from "../lib/deepWater";
import type { Attack, Player, Room, ShipPlacement } from "../types/battleship";
import "./OverlayRecap.css";

/** How long each page holds, in seconds. The win card is shorter: it is one line, read at a glance. */
const WIN_SECS = 8;
const PAGE_SECS = 12;

/** How many times to look for the archived fleets, and how far apart - see the fetch below. */
const FLEET_TRIES = 8;
const FLEET_RETRY_MS = 4000;

type Page = { kind: "win" } | { kind: "honors" } | { kind: "score" } | { kind: "board"; team: number };

/**
 * The post-match recap, on stream: the board source turns into this when a match ends.
 *
 * The same recap a player sees (components/MatchReport), drawn from the same pieces (RecapParts), but
 * as PAGES rather than one long page. A browser source is a fixed rectangle that never scrolls, and
 * the player's recap is a column of panels and two full boards - fitted whole into a 1000px square it
 * would be text nobody on stream could read. So it steps through it instead, a page at a time, and
 * loops: the win card, the honors, the scoreboard, then each fleet's final board with its ships
 * revealed. A viewer who tunes in a minute after the end still gets the result within a lap.
 *
 * Display only. MatchReport archives the match when it mounts; this never does, because a browser
 * source belongs to no player and must not be what writes the record (see RecapParts).
 */
export function OverlayRecap({
  room,
  players,
  attacks,
  deepHides,
  teams,
}: {
  room: Room;
  players: Player[];
  attacks: Attack[];
  deepHides: DeepHide[];
  teams: number[];
}) {
  const t = useT();
  const [frameRef, frame] = useBoxSize<HTMLDivElement>();
  const [cardRef, card] = useBoxSize<HTMLDivElement>();

  const report = useMemo(
    () => buildMatchReport(room, players, attacks, deepHides, igonAnchor(room)),
    [room, players, attacks, deepHides]
  );

  /**
   * Every fleet's ships, from the archive - the only place a browser source can read them from.
   *
   * Retried, because this source usually gets here FIRST: the room flips to finished, and the archive
   * is written a moment later by the players' own recap screens. Until it lands the boards draw shots
   * only, which is still a board worth showing. Gives up after half a minute rather than polling for
   * the length of a post-match chat - every read is a request, and requests are the log budget.
   */
  const [placements, setPlacements] = useState<Map<number, ShipPlacement[]> | null>(null);
  const teamsKey = teams.join(",");
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const wanted = teamsKey.split(",").filter(Boolean).map(Number);
    const look = async () => {
      tries += 1;
      const found = await fetchArchivedPlacements(room.id);
      if (cancelled) return;
      if (found) setPlacements(found);
      const complete = found !== null && wanted.every((tm) => (found.get(tm)?.length ?? 0) > 0);
      if (!complete && tries < FLEET_TRIES) timer = setTimeout(() => void look(), FLEET_RETRY_MS);
    };
    void look();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [room.id, teamsKey]);

  const { boardFor } = useRecapBoards(room, attacks, report, teams, (team) => placements?.get(team) ?? []);

  const pages: Page[] = [
    { kind: "win" },
    ...(report.awards.length > 0 ? [{ kind: "honors" } as Page] : []),
    { kind: "score" },
    ...teams.map((team): Page => ({ kind: "board", team })),
  ];
  const lap = pages.reduce((sum, p) => sum + (p.kind === "win" ? WIN_SECS : PAGE_SECS), 0);

  // The page clock. Starts when this mounts, which is the moment the board source turned into the
  // recap - so every lap opens on the win card, and the first thing on stream is the result.
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(tick);
  }, []);

  let into = Math.floor((now - since) / 1000) % lap;
  let page = pages[0];
  for (const p of pages) {
    const secs = p.kind === "win" ? WIN_SECS : PAGE_SECS;
    if (into < secs) {
      page = p;
      break;
    }
    into -= secs;
  }
  const pageKey = page.kind === "board" ? `board:${page.team}` : page.kind;

  // Text pages are laid out at their natural width and scaled to the source, like the scorebug - see
  // lib/overlayFit. The ceiling lets them grow into a big source rather than sitting small in the
  // middle of it.
  const scale = fitScale(card, frame, 24, 2.4);
  // A board is never transform-scaled: BoardGrid fits its square names to a real cell size, so it
  // is handed the room it has instead, less a margin for its label.
  const boardPx = Math.max(200, Math.round(Math.min(frame.w, frame.h) * 0.9) - 40);

  return (
    <div className="ovr" ref={frameRef}>
      {page.kind === "board" ? (
        <div className="ovr-board" key={pageKey}>
          <BoardGrid {...boardFor(page.team)} maxVh={`${boardPx}px`} maxVw={`${boardPx}px`} />
        </div>
      ) : (
        <div
          className="ovr-card panel stack"
          key={pageKey}
          ref={cardRef}
          style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
        >
          {page.kind === "win" && (
            <div className="stack ovr-win">
              <BrandMark width="9rem" />
              <h1 className="ovr-winner" style={{ color: report.draw ? undefined : teamHex(report.winnerTeam ?? 0) }}>
                {report.draw
                  ? t("Mutual Destruction", "Destruction mutuelle")
                  : `${teamName(report.winnerTeam ?? 0)} ${t("Wins", "gagne")}`}
              </h1>
              <span className="muted">
                {t("Match time", "Durée du match")} {report.duration} · {report.totalShots} {t("shots fired", "tirs effectués")}
              </span>
              {/* Same reason the player's recap carries it: a practice result read as real is one
                  somebody goes looking for on the leaderboard. */}
              {room.practice && (
                <span style={{ color: "var(--hit)", fontSize: "0.82rem" }}>
                  <strong>{t("Practice match", "Match d'entraînement")}</strong>
                </span>
              )}
            </div>
          )}
          {page.kind === "honors" && <RecapHonors awards={report.awards} />}
          {page.kind === "score" && <RecapScoreboard report={report} />}
        </div>
      )}
    </div>
  );
}
