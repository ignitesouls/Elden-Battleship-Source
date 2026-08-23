import { BoardLegend } from "./BoardLegend";
import { MatchInfoBox } from "./MatchInfoBox";
import { OverlayLinkBox } from "./OverlayLinkBox";
import { EndMatchButton } from "./EndMatchButton";
import { PauseControls } from "./PauseControls";
import { LeaveMatchButton } from "./LeaveMatchButton";
import { FireHoldSelect } from "./FireHoldSelect";
import { AutoFireStatus } from "./AutoFireStatus";
import { NOTE_HINT } from "../hooks/usePencilMarks";
import { AUTO_RULE_HINT } from "../lib/deduction";
import type { Challenge } from "../lib/challenges";
import type { Player, Room } from "../types/battleship";
import "./MatchDock.css";

interface Props {
  challenges: Challenge[];
  /** The room's square set, which decides how the key names this board's colours. */
  squareSet?: string | null;
  roomId: string;
  roomCode: string;
  /**
   * The whole room row, and the roster, for the pause controls alone.
   *
   * Everything else in here is handed the two or three fields it uses, which is the better shape and
   * the one to keep. The pause cannot take it: what it reads is three columns that change DURING a
   * match (pause_at, resume_at, pause_log - see lib/matchPause), and a decomposed copy would be a
   * snapshot this bar had no way to know had gone stale. Same for the roster, which carries who has
   * asked for a pause and who has readied up.
   */
  room: Room;
  players: Player[];
  seed?: string | null;
  rejoinCode?: string | null;
  myTeam: number;
  myPlayerId: string;
  activeTeamsList: number[];
  isHost: boolean;
  /** Pencil marks, so the "clear" button can say how many there are and hide when there are none. */
  markCount: number;
  onClearMarks: () => void;
  /** Whether the board is crossing out squares nothing can be hiding in. See lib/deduction. */
  autoRule: boolean;
  onToggleAutoRule: () => void;
  /** How long a square must be held before it fires, in ms. Never zero - see lib/fireHold. */
  holdMs: number;
  onChangeHoldMs: (ms: number) => void;
}

/**
 * The bar across the bottom of the match screen: colour key on the left, room identity and the
 * buttons on the right.
 *
 * Everything here used to be a card in the right-hand column - the key, the room/seed/rejoin box,
 * the overlay link, End match, Leave match. Stacked vertically they took a column roughly as wide
 * as the fleet roster and left most of it empty, which is a lot of screen to spend on things you
 * touch about twice a match. Flattened into a bar they cost one line, and the canvas above gets the
 * width back - which goes mostly to the fire board, the one thing anybody is actually looking at.
 *
 * Full width rather than lined up with the board, so it reads as furniture like the top bar rather
 * than as a caption belonging to one panel.
 */
export function MatchDock({
  challenges,
  squareSet,
  roomId,
  roomCode,
  room,
  players,
  seed,
  rejoinCode,
  myTeam,
  myPlayerId,
  activeTeamsList,
  isHost,
  markCount,
  onClearMarks,
  autoRule,
  onToggleAutoRule,
  holdMs,
  onChangeHoldMs,
}: Props) {
  return (
    <div className="match-dock">
      {/* Renders nothing on a square set that tints nothing (Ringus), and the bar closes up. */}
      <BoardLegend challenges={challenges} setId={squareSet} inline />

      {/* Pushes everything after it to the right edge. A plain spacer rather than margin-left:auto
          on the next item, because that item is conditional - the key is absent on an untinted set
          and the clear-marks button appears only once there are marks to clear. */}
      <span className="match-dock-spacer" />

      <button
        className="match-dock-btn"
        onClick={onToggleAutoRule}
        style={{ borderColor: autoRule ? "var(--accent)" : undefined }}
        title={AUTO_RULE_HINT}
        aria-pressed={autoRule}
      >
        {autoRule ? "✕ Dead water shown" : "✕ Show dead water"}
      </button>

      <FireHoldSelect value={holdMs} onChange={onChangeHoldMs} />

      {/* Next to the fire-hold control because they are the same kind of thing: how this player's
          shots get committed. Renders nothing at all on the objectives boards. */}
      <AutoFireStatus squareSet={squareSet} />

      {markCount > 0 && (
        <button className="match-dock-btn" onClick={onClearMarks} title={NOTE_HINT}>
          Clear {markCount} note{markCount === 1 ? "" : "s"}
        </button>
      )}

      <MatchInfoBox roomCode={roomCode} seed={seed} rejoinCode={rejoinCode} inline />

      {/* The overlay builder is a whole form, so in a bar it opens upward as a popover instead of
          shoving the bar open - see .match-dock-popover. */}
      <div className="match-dock-popover">
        <OverlayLinkBox roomCode={roomCode} team={myTeam} rejoinCode={rejoinCode} teams={activeTeamsList} />
      </div>

      {/* The dock is the canvas layout's answer to the right-hand control column, so it carries the
          same buttons in the same order - see the `controls` fragment in room/BattlePhase. A control
          that exists in one layout and not the other is one nobody can find when they need it. */}
      <PauseControls room={room} players={players} myPlayerId={myPlayerId} isHost={isHost} />
      {isHost && <EndMatchButton roomId={roomId} activeTeamsList={activeTeamsList} />}
      <LeaveMatchButton playerId={myPlayerId} roomCode={roomCode} />
    </div>
  );
}
