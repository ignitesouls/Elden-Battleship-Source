import { useState } from "react";
import { updateRoomSettings } from "../lib/rooms";
import { formatDuration } from "../lib/matchTime";
import { SQUARE_SET_LIST, squareSet, DEFAULT_SQUARE_SET } from "../lib/challenges";
import { strictFill } from "../lib/squareSetFormat";
import { BOARD_SIZES, FLEET_PRESETS, DEFAULT_FLEET_PRESET, fleetFor } from "../types/battleship";
import type { Room, ShipDefinition } from "../types/battleship";

/**
 * Preparation lengths the host can pick, every minute from none up to ten.
 *
 * A dropdown rather than the four buttons this used to be: the buttons offered 0, 1, 4 and 10 and
 * nothing between, so a room that wanted three minutes had to take four. Eleven buttons would be a
 * second wrapping row in a panel that already has eight board sizes in one.
 */
const PREP_MAX_MINUTES = 10;
const PREP_CHOICES = Array.from({ length: PREP_MAX_MINUTES + 1 }, (_, m) => m * 60);

/**
 * Which preset a room's fleet matches, or null for one from before fleets scaled with the board.
 *
 * Has to be answered against THIS board size: "Classic" is 5-4-3-3-2 on a 10x10 and 4-3-2 on a
 * 7x7, so the same stored fleet is Classic on one board and nothing recognizable on another.
 */
function presetNameOf(shipDefs: ShipDefinition[], boardSize: number): string | null {
  const shape = (defs: ShipDefinition[]) => defs.map((d) => d.size).join(",");
  const mine = shape(shipDefs);
  return Object.keys(FLEET_PRESETS).find((k) => shape(fleetFor(boardSize, k)) === mine) ?? null;
}

interface Props {
  room: Room;
  isHost: boolean;
  onError: (message: string | null) => void;
}

/**
 * The match settings, live in the lobby.
 *
 * They used to be set once on the front page, before the room existed - which meant nobody but the
 * creator ever saw them, and a wrong board size could only be fixed by abandoning the room and
 * re-inviting everyone. Here they are visible to the whole lobby and changeable until the match
 * starts, which is also the last moment changing them is safe: after placement begins, the board
 * size is baked into fleets that players have already laid out.
 */
export function MatchSettings({ room, isHost, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const boardSize = room.board_size;
  const cells = boardSize * boardSize;
  const shipDefs = room.ship_defs;
  const preset = presetNameOf(shipDefs, boardSize);
  const prepSeconds = room.prep_seconds ?? 240;

  // A room carrying a length this menu can't offer - set before the choices changed, or by hand -
  // keeps it as an extra entry rather than having the dropdown render blank and silently rewrite it
  // to whatever sits at the top of the list.
  const prepChoices = PREP_CHOICES.includes(prepSeconds)
    ? PREP_CHOICES
    : [...PREP_CHOICES, prepSeconds].sort((a, b) => a - b);
  const set = squareSet(room.square_set ?? DEFAULT_SQUARE_SET);

  const shipCells = shipDefs.reduce((n, s) => n + s.size, 0);

  // How much of the board this set can cover before it has to reuse an objective family. Only
  // meaningful for the authored sets - a flat list of bosses has no such rules.
  const cleanFill = set.format === "bingo" ? strictFill(set.data, cells) : cells;
  const shortfall = Math.max(0, cells - cleanFill);

  async function apply(patch: Parameters<typeof updateRoomSettings>[1]) {
    setBusy(true);
    onError(null);
    try {
      await updateRoomSettings(room.id, patch);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const summary = `${boardSize}x${boardSize} · ${preset ?? `${shipDefs.length} ships`} · ${set.label} · ${formatDuration(
    prepSeconds
  )} prep`;

  // Everyone sees the settings; only the host gets the buttons. A spectator or a player who
  // wandered in deserves to know what they're about to play without having to ask.
  if (!isHost) {
    return (
      <div className="panel row" style={{ gap: "0.5rem", alignItems: "baseline" }}>
        <span className="muted" style={{ fontSize: "0.78rem" }}>Match settings</span>
        <span style={{ fontSize: "0.82rem" }}>{summary}</span>
      </div>
    );
  }

  return (
    <div className="panel stack" style={{ gap: "0.55rem" }}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ fontSize: "0.82rem" }}>
        {open ? "▾" : "▸"} Match settings
        <span className="muted"> - {summary}</span>
      </button>

      {open && (
        <div className="stack" style={{ gap: "0.6rem", paddingLeft: "0.2rem" }}>
          {/* Resizing carries the fleet across rather than leaving a 10x10 Classic fleet on a 5x5
              board, where 17 ship squares in 25 cells cannot even be placed. */}
          <Field label="Board size">
            {BOARD_SIZES.map((n) => (
              <Choice
                key={n}
                active={boardSize === n}
                busy={busy}
                onClick={() =>
                  void apply({ board_size: n, ship_defs: fleetFor(n, preset ?? DEFAULT_FLEET_PRESET) })
                }
              >
                {n}x{n}
              </Choice>
            ))}
          </Field>

          <Field label={`Fleet - ${shipDefs.length} ships, ${shipCells} squares (${Math.round((shipCells / cells) * 100)}% of the board)`}>
            {Object.keys(FLEET_PRESETS).map((k) => (
              <Choice
                key={k}
                active={preset === k}
                busy={busy}
                onClick={() => void apply({ ship_defs: fleetFor(boardSize, k) })}
              >
                {k}
              </Choice>
            ))}
          </Field>
          <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
            {shipDefs.map((s) => `${s.name} (${s.size})`).join(" · ")}
          </span>

          <Field label="Squares">
            {SQUARE_SET_LIST.map((s) => (
              <Choice
                key={s.id}
                active={set.id === s.id}
                busy={busy}
                onClick={() => void apply({ square_set: s.id })}
              >
                {s.label}
              </Choice>
            ))}
          </Field>
          <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
            {set.blurb}
          </span>

          <Field label="Preparation time before firing opens">
            <select
              value={prepSeconds}
              disabled={busy}
              onChange={(e) => void apply({ prep_seconds: Number(e.target.value) })}
            >
              {prepChoices.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {formatDuration(seconds)}
                  {seconds === 0 ? " - none" : ""}
                </option>
              ))}
            </select>
          </Field>

          {/* These sets are written for a 25-square bingo card. Dealt onto 144 cells there aren't
              enough distinct goals to keep every "only one of these" rule, so say so here rather
              than let it be discovered as two squares wanting the same boss. */}
          {shortfall > 0 && (
            <span className="muted" style={{ fontSize: "0.72rem", color: "var(--hit)" }}>
              {set.label} covers {cleanFill} of {cells} squares cleanly - the last {shortfall} will
              overlap goals already on the board. A smaller board fits it better.
            </span>
          )}

          {shipCells > cells * 0.35 && (
            <span className="muted" style={{ fontSize: "0.72rem", color: "var(--hit)" }}>
              That fleet fills a lot of a {boardSize}x{boardSize} board - placement may be cramped.
            </span>
          )}

          <span className="muted" style={{ fontSize: "0.72rem" }}>
            Changing the board or fleet clears any ships already placed.
          </span>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="stack" style={{ gap: "0.25rem" }}>
      <span className="muted" style={{ fontSize: "0.78rem" }}>{label}</span>
      {/* Wraps: eight board sizes don't fit one row on a narrow window. */}
      <div className="row" style={{ gap: "0.35rem", flexWrap: "wrap" }}>{children}</div>
    </label>
  );
}

function Choice({
  active,
  busy,
  onClick,
  children,
}: {
  active: boolean;
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      disabled={busy}
      onClick={onClick}
      aria-pressed={active}
      // minWidth keeps a wrapped row of board sizes from stretching three buttons across the panel
      // while five sit underneath.
      style={{ flex: "1 0 4rem", minWidth: "4rem", borderColor: active ? "var(--accent)" : undefined }}
    >
      {children}
    </button>
  );
}
