import { Fragment, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { activeTeams, sunkCellOrientations, cellLabel, sunkHullFlags } from "../lib/battleshipLogic";
import { groupIntoShots, outcomeText } from "../lib/attackFeed";
import { deepWater, deepMarks } from "../lib/deepWater";
import { challengesForRoom, igonAnchor } from "../lib/challenges";
import { formatDuration, matchTimeAt, matchTimings, matchStartedAt } from "../lib/matchTime";
import { useBattleClock, useBattlePhaseName } from "../hooks/useBattlePhase";
import { teamName, teamHex } from "../lib/teamColors";
import { OverlayGrid, type OverlayLayer } from "../components/OverlayGrid";
import { OverlayFleetStatus } from "../components/OverlayFleetStatus";
import { fetchOverlayFleet, type OverlayFleet } from "../lib/overlayFleet";
import { squaresRevealed } from "../lib/overlayReveal";
import type { Attack, Room } from "../types/battleship";
import { useT } from "../lib/language";
import "./Overlay.css";
import "../components/BoardGrid.css";

// See MatchClock for why the label and the phase key differ.
const PHASE_LABEL = { starting: "Randomization", preparation: "Preparation", match: "Match" } as const;

/**
 * Transparent stream overlay, designed to be dropped into OBS as a Browser Source.
 *
 * Renders ONLY publicly-readable state (room, players, attacks) and never ship positions. That
 * isn't just a privacy choice - an OBS Browser Source is a separate browser context with no
 * saved session, so it authenticates as a brand-new anonymous user who belongs to no team and
 * RLS would return nothing for `fleets` anyway. Keeping the overlay to public data means it
 * works the instant the URL is pasted in, with no login step, and can't leak a fleet to
 * stream-snipers either.
 */
export function Overlay() {
  const { code } = useParams<{ code: string }>();
  const [params] = useSearchParams();
  const state = useRoom(code);
  const t = useT();

  // The app shell paints a background and centers content; a stream overlay must be transparent
  // and flush to the corner, so opt this route out of both while it's mounted.
  //
  // Tagged on <html> as well as <body> because the background color is declared on :root - with
  // body alone, the browser canvas kept painting navy and the overlay filled its OBS source with
  // an opaque rectangle. See the matching selectors in Overlay.css.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  const room = state.room;
  // Drives the reveal gate below: names hold until the board has finished being dealt.
  const battlePhase = useBattlePhaseName(state.attacks, room);
  const startedAt = matchStartedAt(state.attacks);
  const timings = matchTimings(room);

  // The spoiler layout draws the overlay owner's own ships, which needs a credential: this is an
  // anonymous session belonging to no team, so RLS gives it nothing. See lib/overlayFleet.ts.
  const spoilerKey = params.get("key") ?? "";
  const [spoilerFleet, setSpoilerFleet] = useState<OverlayFleet | null>(null);
  const roomStatus = state.room?.status;
  useEffect(() => {
    if (!code || !spoilerKey) {
      setSpoilerFleet(null);
      return;
    }
    let cancelled = false;
    void fetchOverlayFleet(code, spoilerKey).then((f) => {
      if (!cancelled) setSpoilerFleet(f);
    });
    return () => {
      cancelled = true;
    };
    // Keyed on status as well as the room: placements are replaced wholesale when a room resets
    // for a rematch, and an overlay left running overnight would otherwise keep drawing the
    // fleet from a match that finished hours ago.
  }, [code, spoilerKey, roomStatus]);

  if (!room) return null;

  const teams = activeTeams(state.players);
  // Which hulls went down, not how many: OverlayFleetStatus draws silhouettes, so it needs the
  // fleet position of each loss rather than a count. See sunkHullFlags for why that can't be
  // answered from sunk_ship_name, which is what this used to hand it.
  const challenges = challengesForRoom(room.id, room.board_size * room.board_size, room.square_set, room.seed, room.board_perm, room.seed_set_at);

  // ?team=N marks the streamer's own fleet so viewers can tell at a glance which side they're on.
  const rawTeam = params.get("team");
  const highlightTeam = rawTeam !== null && rawTeam !== "" ? Number(rawTeam) : null;

  const showLog = params.get("log") !== "0";
  const logLimit = Number(params.get("logLimit") ?? 6) || 6;

  // Boards are opt-in so existing overlay URLs keep behaving exactly as they did.
  const showGrids = params.get("grids") === "1";
  const singleGrid = params.get("layout") === "one";
  // Ceiling raised well past the old 48 specifically so boss names become possible: they need a
  // 56px cell to survive a stream encoder, which is a 572px board.
  const cellPx = Math.min(96, Math.max(8, Number(params.get("cell") ?? 20) || 20));
  // Opt-in AND phase-gated: the squares stay blank until the match starts, so this column can't be
  // read as a placement cheat sheet either. See lib/overlayReveal.ts.
  const showNames = params.get("names") === "1" && squaresRevealed(room.status, battlePhase);
  const showCoords = params.get("coords") !== "0";
  // Which edge of the browser source the column hugs. Only matters when the source is wider than
  // the overlay itself, which it usually is once you've sized it to a screen edge.
  const side = params.get("side") === "right" ? "right" : "left";

  const showFocus = params.get("focus") !== "0";

  // groupIntoShots sorts newest first, so [0] is the shot that just landed.
  const allShots = groupIntoShots(state.attacks, state.players);
  const shots = allShots.slice(0, logLimit);
  const latestShot = allShots[0] ?? null;
  // Everything in the water, as soon as it happens - this is a caster's source, not a player's board
  // (see lib/deepWater.ts). No team passed, so nothing is held back.
  // Kept rather than thrown away after deepMarks, because Igon has something to say about a square
  // he is not on and the log line for it needs him - see outcomeText.
  const deep = room ? deepWater(room, allShots, state.deepHides, igonAnchor(room)) : null;
  const deepCells = deep ? deepMarks(deep) : undefined;
  const latestOutcome = latestShot ? outcomeText(latestShot, deepCells, null, deep?.igon) : null;

  // Attacks AGAINST a team, expanded so every cell of a sunk hull reads as sunk rather than only
  // the square that landed the killing blow.
  function layerFor(team: number): OverlayLayer {
    const against = state.attacks.filter((a) => a.defender_team === team);
    const sunkCells = sunkCellOrientations(against, room!.board_size);

    return {
      team,
      teamLabel: teamName(team),
      colorHex: teamHex(team),
      sunkHorizontal: sunkCells,
      state: (index: number) => {
        if (sunkCells.has(index)) return "sunk";
        const here = against.filter((a) => a.cell_index === index);
        if (here.some((a) => a.result === "hit")) return "hit";
        if (here.some((a) => a.result === "miss")) return "miss";
        return "none";
      },
      // Own fleet only. Every other team's hulls stay hidden, so even the spoiler overlay can't
      // be turned into a way to see an opponent's board.
      ships:
        spoilerFleet?.team === team
          ? spoilerFleet.placements.map((p) => ({
              row: p.startRow,
              col: p.startCol,
              size: room!.ship_defs[p.shipIndex]?.size ?? 1,
              horizontal: p.isHorizontal,
              shipName: room!.ship_defs[p.shipIndex]?.name ?? "Destroyer",
            }))
          : undefined,
    };
  }

  const layers: OverlayLayer[] = teams.map((t) => ({
    ...layerFor(t),
    // Ringed on the boards that were shot AT, never on the shooter's own - one shot writes a row
    // per opposing team, so the attacker's board is the one place that square didn't change.
    pulseCell:
      showFocus && latestShot && latestShot.attackerTeam !== t ? latestShot.cellIndex : null,
  }));

  /** Hulls of `team` confirmed sunk, from the public log - never from reading their fleet. */
  function sunkHullsFor(team: number): boolean[] {
    return sunkHullFlags(state.attacks, team, room!.ship_defs);
  }

  // Shares its arithmetic with the battle log beside the board (see matchTimeAt), so a stream and
  // the players it is pointed at stamp the same shot with the same time - pauses included.
  const gameTimeAt = (iso: string) => matchTimeAt(startedAt, iso, timings, room);

  return (
    <div className={`ov ov-${side}`}>
      <OverlayClock attacks={state.attacks} room={room} />

      {/* The boss names live HERE rather than on the board.
          A hundred names cannot be rendered into a 200px-wide grid at any font size that survives
          a stream encoder, so instead of shrinking them to mush, the one name that matters right
          now gets the whole width and the display face. The ring pulsing on the board ties it back
          to its square, and the log underneath keeps the last few. */}
      {showFocus && latestShot && (
        <div className="ov-card ov-focus">
          <div className="ov-focus-head">
            <span className="ov-focus-coord">{cellLabel(latestShot.cellIndex, room.board_size)}</span>
            <span className="ov-focus-outcome" style={{ color: latestOutcome!.color }}>
              {latestOutcome!.text}
            </span>
          </div>
          <div className="ov-focus-name">
            {challenges[latestShot.cellIndex]?.name ??
              t(`Square ${latestShot.cellIndex}`, `Case ${latestShot.cellIndex}`)}
          </div>
          <div className="ov-focus-who" style={{ color: teamHex(latestShot.attackerTeam) }}>
            {latestShot.who}
          </div>
        </div>
      )}

      {/* Fleets as silhouettes, not a counter - see OverlayFleetStatus. */}
      <div className="ov-card ov-teams">
        {teams.map((t) => (
          <OverlayFleetStatus
            key={t}
            teamLabel={teamName(t)}
            colorHex={teamHex(t)}
            shipDefs={room.ship_defs}
            sunkHulls={sunkHullsFor(t)}
            isMine={highlightTeam === t}
          />
        ))}
      </div>

      {showGrids && layers.length > 0 && (
        singleGrid ? (
          // Both fleets composited onto one board. Works because every team fires at the SAME
          // named grid, so a cell means the same square on every layer and stacking them is
          // meaningful rather than merely compact.
          <div className="ov-card">
            <OverlayGrid
              boardSize={room.board_size}
              cell={cellPx}
              layers={layers}
              showCoords={showCoords}
              cellName={showNames ? (i) => challenges[i]?.short ?? challenges[i]?.name ?? null : undefined}
              // What the water gave up. Already computed above for the log, and until now that was
              // the ONLY place a find appeared on this overlay - the boards themselves drew a plain
              // splash on the rarest square in the match. See lib/deepWater.ts.
              deepCells={deepCells}
            />
          </div>
        ) : (
          // Stacked, not side by side: this is designed to run down the edge of a stream, where
          // vertical space is free and horizontal space is the thing covering the game.
          <div className="ov-grids">
            {layers.map((l) => (
              <div key={l.team} className="ov-card">
                <OverlayGrid
                  boardSize={room.board_size}
                  cell={cellPx}
                  layers={[l]}
                  label={highlightTeam === l.team ? `${l.teamLabel} ${t("- you", "- vous")}` : l.teamLabel}
                  showCoords={showCoords}
                  cellName={showNames ? (i) => challenges[i]?.short ?? challenges[i]?.name ?? null : undefined}
                  // Every board, not only the one that was fired at. A find is a fact about the
                  // ROOM rather than about any one fleet, and the shot that turned it up wrote no
                  // row at all against the crew who fired it - so a find drawn only where a splash
                  // landed would be missing from its own finder's board.
                  deepCells={deepCells}
                />
              </div>
            ))}
          </div>
        )
      )}

      {showLog && shots.length > 0 && (
        <div className="ov-card ov-log">
          {shots.map((shot) => {
            const outcome = outcomeText(shot, deepCells, room, deep?.igon);
            const challenge = challenges[shot.cellIndex];
            return (
              // Fragment rather than a wrapper, so the note becomes its own line in the log's
              // column instead of being crushed into the nowrap row above it.
              <Fragment key={shot.key}>
                <div className="ov-log-row">
                  <span className="ov-log-time">{gameTimeAt(shot.at)}</span>
                  <span className="ov-log-who" style={{ color: teamHex(shot.attackerTeam) }}>
                    {shot.who}
                  </span>
                  <span className="ov-log-target">{challenge?.name ?? `#${shot.cellIndex}`}</span>
                  <span className="ov-log-outcome" style={{ color: outcome.color }}>
                    {outcome.text}
                  </span>
                </div>
                {outcome.note && (
                  <div className="ov-log-note" style={{ color: outcome.color }}>
                    &ldquo;{outcome.note}&rdquo;
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The clock card, as its own component purely so that the tick stops here.
 *
 * `useBattleClock` re-renders whatever calls it once a second, and this used to be called by the
 * Overlay page itself - which meant that every second, on the streamer's machine, an OBS browser
 * source rebuilt the room's whole challenge list, regrouped the entire attack log into shots, re-ran
 * the deep-water reveal and recomputed a result layer for every fleet, before re-rendering every
 * board on the overlay. All of it to move two digits.
 *
 * Nothing else on the page read `phase`, so lifting the card out is a pure structural move: the same
 * markup lands in the same slot, and the parent now re-renders only when match data actually changes.
 * Same trick, same reason, as MatchClock on the player's screen - see useBattlePhase.
 */
function OverlayClock({ attacks, room }: { attacks: Attack[]; room: Room | null }) {
  const t = useT();
  const phase = useBattleClock(attacks, room);
  const TR_PHASE_LABEL: Record<keyof typeof PHASE_LABEL, string> = {
    starting: t("Randomization", "Randomisation"),
    preparation: t("Preparation", "Préparation"),
    match: t("Match", "Match"),
  };
  const clock = phase
    ? phase.phase === "match"
      ? formatDuration(phase.matchElapsed)
      : `-${formatDuration(phase.countdown)}`
    : "--:--";

  return (
    <div className="ov-card ov-clock">
      <span className="ov-phase">{phase ? TR_PHASE_LABEL[phase.phase] : t("Match", "Match")}</span>
      <span className="ov-time">{clock}</span>
    </div>
  );
}
