import { useState } from "react";
import { updateRoomSettings } from "../lib/rooms";
import { formatDuration } from "../lib/matchTime";
import { SQUARE_SET_LIST, squareSet, displaySquareSet, bossSetForRoster, DEFAULT_SQUARE_SET } from "../lib/challenges";
import { squarePool, maxBoardSize, clampBoardSize } from "../lib/challenges";
import { strictFill } from "../lib/squareSetFormat";
import { BOARD_SIZES, FLEET_PRESETS, DEFAULT_FLEET_PRESET, fleetFor, presetNameOf } from "../types/battleship";
import type { Room, Player } from "../types/battleship";

/**
 * Preparation lengths the host can pick, every minute from none up to ten.
 *
 * A dropdown rather than the four buttons this used to be: the buttons offered 0, 1, 4 and 10 and
 * nothing between, so a room that wanted three minutes had to take four. Eleven buttons would be a
 * second wrapping row in a panel that already has ten board sizes in one.
 */
const PREP_MAX_MINUTES = 10;
const PREP_CHOICES = Array.from({ length: PREP_MAX_MINUTES + 1 }, (_, m) => m * 60);

/**
 * A prep length as it reads in the dropdown: a bare minute count, the unit living in the field
 * label. Clock faces down a list of whole minutes are all zeroes after the colon and harder to
 * scan than "0 1 2 3". A length that isn't a whole minute can only be one set by hand, so it
 * keeps the clock rather than being rounded into a lie.
 */
function prepLabel(seconds: number): string {
  return seconds % 60 === 0 ? String(seconds / 60) : formatDuration(seconds);
}

interface Props {
  room: Room;
  /** The lobby's roster, which decides which cut of the boss board "Bosses" means. */
  players: Player[];
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
export function MatchSettings({ room, players, isHost, onError }: Props) {
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
  // What the room is told it is playing. Identical to `set` except on a variant, which describes
  // itself as its parent because that is the only set anyone here chose - see squareSets.variantOf.
  const shownSet = squareSet(displaySquareSet(set.id));

  const shipCells = shipDefs.reduce((n, s) => n + s.size, 0);

  // The biggest board this set can deal without repeating a square. Read off `set` and not the set
  // the room DISPLAYS, because the two differ exactly where the cap does: a 2v2 lobby shows
  // "Bosses" while sitting on the 164-square cut, whose ceiling is two sizes lower than the full
  // board's.
  const sizeCap = maxBoardSize(set);

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

  const summary = `${boardSize}x${boardSize} · ${preset ?? `${shipDefs.length} ships`} · ${shownSet.label} · ${formatDuration(
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
                unavailable={n > sizeCap}
                title={
                  n > sizeCap
                    ? `${shownSet.label} has ${squarePool(set)} squares - a ${n}x${n} board would deal ${
                        n * n - squarePool(set)
                      } of them twice. Its biggest board is ${sizeCap}x${sizeCap}.`
                    : undefined
                }
                onClick={() =>
                  void apply({ board_size: n, ship_defs: fleetFor(n, preset ?? DEFAULT_FLEET_PRESET) })
                }
              >
                {n}x{n}
              </Choice>
            ))}
          </Field>
          {/* Only worth a line when the cap actually costs the host something. On a set that reaches
              the top of the list there is nothing to explain, and on the boss board this is also
              where a 2v2 lobby finds out why the two biggest sizes went away. */}
          {sizeCap < BOARD_SIZES[BOARD_SIZES.length - 1] && (
            <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
              {shownSet.label} has {squarePool(set)} squares, so it fills a {sizeCap}x{sizeCap} board at
              most - bigger boards would put the same square in two places.
            </span>
          )}

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

          {/* One button per set a person can choose. The boss button is the one that does not write
              its own id: which cut of the boss board it means is the roster's answer, not the
              host's, and picking it here rather than in the click handler alone is what makes it
              land right when the host chooses Bosses before anyone has joined - the sync in
              LobbyPhase then follows the roster from there. */}
          <Field label="Squares">
            {SQUARE_SET_LIST.map((s) => (
              <Choice
                key={s.id}
                active={displaySquareSet(set.id) === s.id}
                busy={busy}
                onClick={() => {
                  const target = s.id === DEFAULT_SQUARE_SET ? bossSetForRoster(players) : s.id;
                  // A set with a lower ceiling drags the board down to it in the SAME write, fleet
                  // and all. Two writes would deal one board that repeats squares in between, and
                  // leaving the size alone would deal that board for the whole match - which is
                  // what happened before this, invisibly, whenever a host on a big board tried the
                  // smallest set.
                  const size = clampBoardSize(boardSize, target);
                  void apply({
                    square_set: target,
                    ...(size === boardSize
                      ? {}
                      : { board_size: size, ship_defs: fleetFor(size, preset ?? DEFAULT_FLEET_PRESET) }),
                  });
                }}
              >
                {s.label}
              </Choice>
            ))}
          </Field>
          <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
            {shownSet.blurb}
          </span>

          <Field label="Preparation time before firing opens (minutes)">
            <select
              value={prepSeconds}
              disabled={busy}
              onChange={(e) => void apply({ prep_seconds: Number(e.target.value) })}
            >
              {prepChoices.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {prepLabel(seconds)}
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
              {shownSet.label} covers {cleanFill} of {cells} squares cleanly - the last {shortfall} will
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
      {/* Wraps: ten board sizes don't fit one row on a narrow window. */}
      <div className="row" style={{ gap: "0.35rem", flexWrap: "wrap" }}>{children}</div>
    </label>
  );
}

function Choice({
  active,
  busy,
  /** Out of reach on this set rather than momentarily unclickable - carries `title` and dims. */
  unavailable,
  title,
  onClick,
  children,
}: {
  active: boolean;
  busy: boolean;
  unavailable?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      disabled={busy || unavailable}
      title={title}
      onClick={onClick}
      aria-pressed={active}
      // minWidth keeps a wrapped row of board sizes from stretching three buttons across the panel
      // while five sit underneath. An unavailable size stays in the row at half opacity rather than
      // vanishing: a list that silently loses its last two entries when the roster drops to a 2v2
      // reads as a bug, where a greyed button with a reason on hover reads as the rule it is.
      style={{
        flex: "1 0 4rem",
        minWidth: "4rem",
        borderColor: active ? "var(--accent)" : undefined,
        opacity: unavailable ? 0.4 : undefined,
      }}
    >
      {children}
    </button>
  );
}
