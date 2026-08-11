import { useMemo, type ReactNode } from "react";
import { BoardGrid, type CellVisual, type ShipOverlay, type SquareCount } from "./BoardGrid";
import { sunkCellOrientations, eliminatedTeamsFromAttacks } from "../lib/battleshipLogic";
import { challengesForRoom } from "../lib/challenges";
import { ruledOutCells } from "../lib/deduction";
import { deepMarks, type DeepWater } from "../lib/deepWater";
import { teamName, teamHex } from "../lib/teamColors";
import { boardSideFor } from "../hooks/useBoxSize";
import type { Attack, Fleet, Room } from "../types/battleship";

interface Props {
  room: Room;
  /** The crew whose shoulder we're looking over. */
  team: number;
  attacks: Attack[];
  fleets: Fleet[];
  activeTeamsList: number[];
  /** This crew's square tallies, drawn where the crew themselves see them - on the board they fire at. */
  counts?: Map<number, SquareCount[]>;
  /**
   * Everything in the room's water (see lib/deepWater.ts), narrowed to this crew's view below.
   *
   * Handed in rather than derived here because working it out needs the player roster this component
   * has never taken, and the page above has already built it for the battle log.
   */
  deep?: DeepWater;
  /** The measured stage this has to fit inside, so the two boards can be sized rather than capped. */
  stage: { w: number; h: number };
  /**
   * Canvas mode: hand each board to the caller to be wrapped in a movable panel, and let it fill
   * whatever box that panel has rather than sizing itself into the stage.
   *
   * A callback rather than a `fill` flag plus markup in the caller, because the two boards here are
   * built from a crew's own narrow view of the match - what they've fired at, what's hit them - and
   * that derivation should exist once. The panel is only a frame around it.
   */
  wrapBoard?: (id: "crewFire" | "crewFleet", title: string, board: ReactNode) => ReactNode;
}

/** Vertical room the "riding with" line and the policy warning take out of the stage. */
const NOTE_H = 22;

/**
 * One crew's exact view of the match, read-only.
 *
 * Distinct from the "Red Fleet" spectator mode, which shows that team's board from the outside -
 * useful for watching them get hit, useless for following what they're actually thinking about.
 * A player looks at TWO boards: the enemy waters they've been firing into, and their own fleet
 * taking damage. This renders both, which is what someone sitting in the same Discord call needs
 * to follow the conversation.
 *
 * There is no fire handler anywhere in here - not a disabled one, none at all. A spectator has no
 * player row and no team, so RLS would reject an attack from them regardless; this just avoids
 * dangling a control that could never work.
 */
export function SpectateWithCrew({
  room,
  team,
  attacks,
  fleets,
  activeTeamsList,
  counts,
  deep,
  stage,
  wrapBoard,
}: Props) {
  const boardSize = room.board_size;
  const shipDefs = room.ship_defs;

  // Riding along means reading the same squares the crew reads, on both of their boards - the
  // whole point is following what they're deciding between, which bare colored cells can't carry.
  const challenges = useMemo(
    () => challengesForRoom(room.id, boardSize * boardSize, room.square_set, room.seed),
    [room.id, boardSize, room.square_set, room.seed]
  );
  const cellText = (i: number) => {
    const c = challenges[i];
    if (!c) return null;
    return {
      label: c.short ?? c.name,
      title: c.title ?? c.name,
      region: c.region,
      color: c.color,
    };
  };

  const outgoing = attacks.filter((a) => a.attacker_team === team);
  const incoming = attacks.filter((a) => a.defender_team === team);

  const firedSunk = sunkCellOrientations(outgoing, boardSize);
  const takenSunk = sunkCellOrientations(incoming, boardSize);

  /** What this crew knows about enemy waters: only squares they have personally fired at. */
  function targetVisual(index: number): CellVisual {
    if (firedSunk.has(index)) return "sunk";
    const shots = outgoing.filter((a) => a.cell_index === index);
    if (shots.some((a) => a.result === "hit")) return "hit";
    if (shots.some((a) => a.result === "miss")) return "miss";
    return "empty";
  }

  function ownVisual(index: number): CellVisual {
    if (takenSunk.has(index)) return "sunk";
    const hits = incoming.filter((a) => a.cell_index === index);
    if (hits.some((a) => a.result === "hit")) return "hit";
    if (hits.some((a) => a.result === "miss")) return "miss";
    return "empty";
  }

  // Enemy hulls this crew has actually sunk. Read off the resolved attack rows, never from the
  // opposing fleet - so the view stays exactly as blind as the crew is.
  const wrecks: ShipOverlay[] = outgoing
    .filter((a) => a.result === "sunk" && a.sunk_start_row !== null)
    .map((a) => ({
      row: a.sunk_start_row!,
      col: a.sunk_start_col!,
      size: a.sunk_ship_size!,
      horizontal: a.sunk_horizontal!,
      shipName: a.sunk_ship_name!,
      colorHex: teamHex(a.defender_team),
    }));

  const ownFleet = fleets.find((f) => f.team === team);
  const ownShips: ShipOverlay[] = (ownFleet?.placements ?? []).map((p) => ({
    row: p.startRow,
    col: p.startCol,
    size: shipDefs[p.shipIndex].size,
    horizontal: p.isHorizontal,
    shipName: shipDefs[p.shipIndex].name,
    colorHex: teamHex(team),
  }));

  /**
   * The crew's own dead water, worked out from the crew's own shots (see lib/deduction).
   *
   * Riding along promises their screen, and their screen has these crosses on it - it is on by
   * default for every fleet now, so leaving them off here would mean a caster reading squares aloud
   * arguing over a gap the crew can see is already ruled out. Computed from the same `outgoing` the
   * boards above are drawn from, so it is exactly as blind as the crew is.
   *
   * Not offered as a toggle the way it is in a match: this view has no controls of its own, and it
   * isn't the spectator's board to have a preference about.
   */
  const eliminated = eliminatedTeamsFromAttacks(attacks, shipDefs.length);
  const liveOpponents = activeTeamsList.filter((t) => t !== team && !eliminated.has(t));
  const deadWater = useMemo(
    () => ruledOutCells({ boardSize, shipDefs, outgoing, opponentTeams: liveOpponents }),
    // outgoing and liveOpponents are rebuilt every render, so their identities can't be deps
    // without defeating the memo. Same reasoning as BattlePhase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardSize, shipDefs, attacks, team, liveOpponents.join(",")]
  );

  /**
   * What this crew has found in the water - their finds, not the room's.
   *
   * Narrowed with the crew's own team and their own fired squares, which is the identical call
   * BattlePhase makes, because riding along promises their screen and their screen is the one place
   * the secrecy still applies. A caster who wants every fleet's finds at once has the "All fleets"
   * boards for it; this view is the one that is deliberately as blind as the people in it.
   *
   * The `firedCells` gate does a second job here for free: it keeps a woken sleeper off squares this
   * crew never shot at, so nothing is ever drawn on a cell their board shows as untouched.
   */
  const deepCells = useMemo(
    () => (deep ? deepMarks(deep, team, new Set(outgoing.map((a) => a.cell_index))) : undefined),
    // `outgoing` is rebuilt every render, so it can't be a dep without defeating the memo - the
    // attacks it's filtered from are. Same reasoning as deadWater above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deep, team, attacks]
  );

  const opponents = activeTeamsList.filter((t) => t !== team).map(teamName).join(" & ");

  // Two boards across, inside whatever the stage has left after this view's own notes. Measured
  // rather than capped in vh for the reason the whole spectator page now is - see Spectator.css.
  const notes = NOTE_H * (ownFleet ? 1 : 2);
  const side = boardSideFor({ w: stage.w, h: Math.max(0, stage.h - notes) }, 2);

  const fireTitle = opponents ? `Their shots on ${opponents}` : "Their shots";
  const fleetTitle = `${teamName(team)} - their fleet`;
  // Sized by the panel in canvas mode and by the stage otherwise. Everything else about the two
  // boards is identical, which is the point of deriving them once.
  const sizing = wrapBoard ? { fill: true } : { maxVh: `${side}px`, maxVw: `${side}px` };

  const fireBoard = (
    <BoardGrid
      boardSize={boardSize}
      cellVisual={targetVisual}
      label={wrapBoard ? undefined : fireTitle}
      ships={wrecks}
      sunkOrientation={firedSunk}
      cellText={cellText}
      // This board only, because this is the one the crew keeps their counters on - riding
      // along means seeing their screen, and their own fleet board has no tallies to show.
      counts={counts}
      // Same reason, and the same board: dead water is a verdict on enemy waters. So is a find -
      // every one of these sits on a square this crew fired into.
      autoRuledCells={deadWater}
      deepCells={deepCells}
      {...sizing}
    />
  );

  const fleetBoard = (
    <BoardGrid
      boardSize={boardSize}
      cellVisual={ownVisual}
      label={wrapBoard ? undefined : fleetTitle}
      ships={ownShips}
      sunkOrientation={takenSunk}
      cellText={cellText}
      {...sizing}
    />
  );

  // On the canvas the notes have nowhere to sit - the panels are absolutely positioned - and the
  // panel titles already name both boards, so the framing they carried is no longer missing.
  if (wrapBoard) {
    return (
      <>
        {wrapBoard("crewFire", fireTitle, fireBoard)}
        {wrapBoard("crewFleet", fleetTitle, fleetBoard)}
      </>
    );
  }

  return (
    <div className="spectate-crew">
      <span className="spectate-note">
        Riding with <strong style={{ color: teamHex(team) }}>{teamName(team)}</strong> - you see
        only what they see, and can't fire.
      </span>

      <div className="spectate-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
        {fireBoard}
        {fleetBoard}
      </div>

      {!ownFleet && (
        <span className="spectate-note">
          Their ship positions aren't readable - apply the <code>fleets select by spectator</code>{" "}
          policy to see them. Shot results are shown either way.
        </span>
      )}
    </div>
  );
}
