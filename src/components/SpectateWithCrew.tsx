import { useMemo, type ReactNode } from "react";
import { BoardGrid, type CellVisual, type ShipOverlay, type SquareCount } from "./BoardGrid";
import { sunkCellOrientations, eliminatedTeamsFromAttacks } from "../lib/battleshipLogic";
import { cellVisuals } from "../lib/cellVisuals";
import { challengesForRoom } from "../lib/challenges";
import type { Challenge } from "../lib/challenges";
import { squaresRevealed } from "../lib/overlayReveal";
import { useBattlePhaseName } from "../hooks/useBattlePhase";
import { ruledOutCells } from "../lib/deduction";
import { deepMarks, type DeepWater } from "../lib/deepWater";
import { teamName, teamHex } from "../lib/teamColors";
import { boardSideFor } from "../hooks/useBoxSize";
import type { Attack, Fleet, Room } from "../types/battleship";

/** Stable identity, so hiding the board does not re-render both boards on each tick. */
const NO_CHALLENGES: Challenge[] = [];

interface Props {
  room: Room;
  /** The crew whose shoulder we're looking over. */
  team: number;
  attacks: Attack[];
  /**
   * Every fleet this viewer is allowed to read, which is not the same thing in both callers.
   *
   * Narrowed to the two fields actually used, so the watch page can pass the one fleet an RPC handed
   * it without inventing a ship_grid and a hit table it was never given. A full `Fleet[]` still
   * satisfies it, so the spectator page is unchanged.
   *
   * Empty is a supported state, not a broken one: an audience member on /watch has no spectator seat
   * and therefore cannot read `fleets` at all, and the boards below are honest without it.
   */
  fleets: Pick<Fleet, "team" | "placements">[];
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
  /**
   * What to say when this crew's hulls can't be drawn, for the audience that is reading it.
   *
   * The default below is written for the person running the site: it names an RLS policy, because on
   * the spectator page a missing fleet means that policy has not been applied and the fix is a
   * migration. On the watch page it means the streamer has not opted into showing their ships, which
   * is a choice rather than a fault, and telling four hundred viewers to apply a database policy
   * would be nonsense. Same absence, two completely different sentences.
   */
  noFleetNote?: ReactNode;
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
  noFleetNote,
}: Props) {
  const boardSize = room.board_size;
  const shipDefs = room.ship_defs;

  // Riding along means reading the same squares the crew reads, on both of their boards - the
  // whole point is following what they're deciding between, which bare colored cells can't carry.
  const dealtChallenges = useMemo(
    () => challengesForRoom(room.id, boardSize * boardSize, room.square_set, room.seed, room.board_perm),
    [room.id, boardSize, room.square_set, room.seed, room.board_perm]
  );
  // Held back through the RANDOMIZATION window, on the same beat as the players own board and the
  // overlays - a spectator reading out the squares ten seconds before the crews can see them would
  // be calling a board that is still being dealt. See lib/overlayReveal.ts.
  const battlePhase = useBattlePhaseName(attacks, room);
  const challenges = squaresRevealed(room.status, battlePhase) ? dealtChallenges : NO_CHALLENGES;
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

  // Both boards resolved in one walk of the log each, rather than one filter per square - see
  // lib/cellVisuals. What this crew knows about enemy waters is only the squares they have
  // personally fired at, which is `outgoing` doing that job rather than any rule in here.
  const targetVisuals = cellVisuals(outgoing, firedSunk);
  const ownVisuals = cellVisuals(incoming, takenSunk);

  const targetVisual = (index: number): CellVisual => targetVisuals.get(index) ?? "empty";
  const ownVisual = (index: number): CellVisual => ownVisuals.get(index) ?? "empty";

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
        Riding with <strong style={{ color: teamHex(team) }}>{teamName(team)}</strong>. You see only
        what they see, and you can't fire.
      </span>

      <div className="spectate-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
        {fireBoard}
        {fleetBoard}
      </div>

      {!ownFleet && (
        <span className="spectate-note">
          {noFleetNote ?? (
            <>
              Their ship positions can't be read. Apply the <code>fleets select by spectator</code>{" "}
              policy to see them. Shot results show either way.
            </>
          )}
        </span>
      )}
    </div>
  );
}
