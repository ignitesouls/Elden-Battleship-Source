import { useEffect, useMemo, useRef, useState } from "react";
import { BoardGrid, type CellVisual, type ShipOverlay } from "../../components/BoardGrid";
import { validatePlacements, randomPlacements, isCaptain, captainOf } from "../../lib/battleshipLogic";
import { submitPlacement, confirmPlacement } from "../../lib/rooms";
import { teamName, teamHex } from "../../lib/teamColors";
import { EndMatchButton } from "../../components/EndMatchButton";
import { LeaveMatchButton } from "../../components/LeaveMatchButton";
import { TeamBox } from "../../components/TeamBox";
import type { Room, Fleet, Player, ShipPlacement, TeamReady } from "../../types/battleship";

interface Props {
  room: Room;
  myTeam: number;
  myPlayerId: string;
  myFleet: Fleet;
  players: Player[];
  activeTeamsList: number[];
  teamReady: TeamReady[];
  isHost: boolean;
}

export function PlacementPhase({
  room,
  myTeam,
  myPlayerId,
  myFleet,
  players,
  activeTeamsList,
  teamReady,
  isHost,
}: Props) {
  const iAmCaptain = isCaptain(players, myTeam, myPlayerId);
  const [placements, setPlacements] = useState<ShipPlacement[]>(myFleet.placements ?? []);
  const [selectedShip, setSelectedShip] = useState(0);
  const [horizontal, setHorizontal] = useState(true);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adopt server state once (e.g. a teammate already placed some ships) without clobbering local edits.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!hydrated && myFleet.placements) {
      setPlacements(myFleet.placements);
      setHydrated(true);
    } else if (!hydrated) {
      setHydrated(true);
    }
  }, [hydrated, myFleet.placements]);

  const boardSize = room.board_size;
  const shipDefs = room.ship_defs;
  const placedShipIndices = new Set(placements.map((p) => p.shipIndex));

  const { valid: allValid, shipGrid } = useMemo(
    () => validatePlacements(boardSize, shipDefs, placements),
    [boardSize, shipDefs, placements]
  );
  const allPlaced = placements.length === shipDefs.length;

  const readyTeams = new Set(teamReady.filter((t) => t.ready).map((t) => t.team));
  const notReadyTeams = activeTeamsList.filter((t) => !readyTeams.has(t));
  const allReady = notReadyTeams.length === 0;

  // Battle opens automatically the instant every team confirms - no host click needed. That
  // trigger lives in Room.tsx rather than here, because this component doesn't mount at all for a
  // host who is spectating, and a room whose host wasn't on a fleet could therefore never start.
  //
  // `R` flips orientation, matching the desktop client's placement hotkey. If the selected ship
  // is already on the board this rotates it where it stands rather than only affecting the next
  // placement, which is what people actually expect the key to do once ships are down.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "r" && e.key !== "R") return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return; // don't hijack typing
      e.preventDefault();
      if (placements.some((p) => p.shipIndex === selectedShip)) rotateShipRef.current(selectedShip);
      else setHorizontal((h) => !h);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placements, selectedShip]);

  // rotateShip is redefined every render; hold it in a ref so the key handler above doesn't have
  // to re-subscribe on each one.
  const rotateShipRef = useRef<(shipIndex: number) => void>(() => {});

  function previewCells(): Set<number> {
    if (hoverIndex === null || placedShipIndices.has(selectedShip)) return new Set();
    const size = shipDefs[selectedShip].size;
    const dr = horizontal ? 0 : 1;
    const dc = horizontal ? 1 : 0;
    const row = Math.floor(hoverIndex / boardSize);
    const col = hoverIndex % boardSize;
    const cells = new Set<number>();
    for (let i = 0; i < size; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      if (r >= 0 && r < boardSize && c >= 0 && c < boardSize) cells.add(r * boardSize + c);
    }
    return cells;
  }

  function previewIsValid(cells: Set<number>): boolean {
    const size = shipDefs[selectedShip].size;
    if (cells.size !== size) return false;
    for (const idx of cells) {
      if (shipGrid[idx]) return false;
    }
    return true;
  }

  const preview = previewCells();
  const previewValid = preview.size > 0 && previewIsValid(preview);

  function cellVisual(index: number): CellVisual {
    if (preview.has(index)) return previewValid ? "preview-valid" : "preview-invalid";
    return "empty"; // placed ships are drawn as sprite overlays instead of flat cell color
  }

  const shipOverlays: ShipOverlay[] = placements.map((p) => ({
    row: p.startRow,
    col: p.startCol,
    size: shipDefs[p.shipIndex].size,
    horizontal: p.isHorizontal,
    shipName: shipDefs[p.shipIndex].name,
    colorHex: teamHex(myTeam),
  }));

  /** Which already-placed ship occupies a cell, or -1. */
  function shipAtCell(index: number): number {
    const row = Math.floor(index / boardSize);
    const col = index % boardSize;
    for (const p of placements) {
      const size = shipDefs[p.shipIndex].size;
      for (let i = 0; i < size; i++) {
        const r = p.startRow + (p.isHorizontal ? 0 : i);
        const c = p.startCol + (p.isHorizontal ? i : 0);
        if (r === row && c === col) return p.shipIndex;
      }
    }
    return -1;
  }

  /** Flips a placed ship in place, keeping its start cell, if the new footprint still fits. */
  function rotateShip(shipIndex: number) {
    const p = placements.find((x) => x.shipIndex === shipIndex);
    if (!p) return;
    const size = shipDefs[shipIndex].size;
    const flipped = !p.isHorizontal;

    const others = placements.filter((x) => x.shipIndex !== shipIndex);
    const occupied = new Set<number>();
    for (const o of others) {
      const osize = shipDefs[o.shipIndex].size;
      for (let i = 0; i < osize; i++) {
        occupied.add(
          (o.startRow + (o.isHorizontal ? 0 : i)) * boardSize + (o.startCol + (o.isHorizontal ? i : 0))
        );
      }
    }

    for (let i = 0; i < size; i++) {
      const r = p.startRow + (flipped ? 0 : i);
      const c = p.startCol + (flipped ? i : 0);
      if (r < 0 || r >= boardSize || c < 0 || c >= boardSize) return; // would hang off the board
      if (occupied.has(r * boardSize + c)) return; // would overlap a neighbor
    }

    setPlacements([...others, { ...p, isHorizontal: flipped }].sort((a, b) => a.shipIndex - b.shipIndex));
  }
  rotateShipRef.current = rotateShip;

  function handleCellClick(index: number) {
    // Clicking a ship you've already placed rotates it in place - the common fix-up action,
    // and much less fiddly than clearing it and re-placing from the list.
    const existing = shipAtCell(index);
    if (existing >= 0 && existing !== selectedShip) {
      setSelectedShip(existing);
      return;
    }
    if (existing >= 0 && existing === selectedShip) {
      rotateShip(existing);
      return;
    }
    placeSelectedShip();
  }

  function placeSelectedShip() {
    if (hoverIndex === null || !previewValid) return;
    const row = Math.floor(hoverIndex / boardSize);
    const col = hoverIndex % boardSize;
    const next = placements.filter((p) => p.shipIndex !== selectedShip);
    next.push({ shipIndex: selectedShip, startRow: row, startCol: col, isHorizontal: horizontal });
    next.sort((a, b) => a.shipIndex - b.shipIndex);
    setPlacements(next);

    const nextUnplaced = shipDefs.findIndex((_, i) => i !== selectedShip && !next.some((p) => p.shipIndex === i));
    if (nextUnplaced >= 0) setSelectedShip(nextUnplaced);
  }

  function clearShip(shipIndex: number) {
    setPlacements(placements.filter((p) => p.shipIndex !== shipIndex));
    setSelectedShip(shipIndex);
  }

  function randomize() {
    setPlacements(randomPlacements(boardSize, shipDefs));
  }

  function clearAll() {
    setPlacements([]);
    setSelectedShip(0);
  }

  async function handleConfirm() {
    if (!allPlaced || !allValid) return;
    setSaving(true);
    setError(null);
    try {
      const { shipGrid, shipIndexGrid } = validatePlacements(boardSize, shipDefs, placements);
      await submitPlacement(room.id, myTeam, shipGrid, shipIndexGrid, placements, shipDefs);
      await confirmPlacement(room.id, myTeam, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleUnconfirm() {
    setSaving(true);
    try {
      await confirmPlacement(room.id, myTeam, false);
    } finally {
      setSaving(false);
    }
  }

  // Only the captain lays out the fleet - the database enforces it too (guard_fleet_placement),
  // so this isn't the boundary, just the difference between a read-only screen and a screen full
  // of controls that would throw. Crewmates watch it happen live: fleets stream over realtime and
  // every teammate can already read their own team's row.
  if (!iAmCaptain) {
    const captain = captainOf(players, myTeam);
    return (
      <div className="row" style={{ alignItems: "flex-start", justifyContent: "center", gap: "2rem" }}>
        <BoardGrid
          boardSize={boardSize}
          cellVisual={cellVisual}
          label={`${teamName(myTeam)} - ${captain?.nickname ?? "your captain"} is placing`}
          ships={shipOverlays}
          maxVh="calc(100vh - 5.5rem)"
          maxVw={62}
        />

        <div
          className="stack battle-sidebar"
          style={{ minWidth: 220, gap: "0.75rem", maxHeight: "calc(100vh - 5.5rem)", minHeight: 0, overflowY: "auto" }}
        >
          <div className="panel stack" style={{ gap: "0.4rem" }}>
            <h3 style={{ margin: 0 }}>Standing by</h3>
            <span className="muted" style={{ fontSize: "0.8rem", lineHeight: 1.4 }}>
              <strong>{captain?.nickname ?? "Your captain"}</strong> is laying out the fleet - the
              first crewmate to pick a fleet captains it. You'll see each ship as it's placed.
            </span>
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              {myFleet.placement_confirmed
                ? allReady
                  ? "Every fleet is ready. Battle starting..."
                  : `Confirmed. Waiting on: ${notReadyTeams.map((t) => teamName(t)).join(", ")}`
                : `${placements.length} of ${shipDefs.length} ships placed.`}
            </span>
          </div>

          {activeTeamsList.map((team) => (
            <TeamBox
              key={team}
              team={team}
              players={players}
              shipDefs={shipDefs}
              isMine={team === myTeam}
              myPlayerId={myPlayerId}
            />
          ))}

          {isHost && <EndMatchButton roomId={room.id} activeTeamsList={activeTeamsList} />}
          <LeaveMatchButton playerId={myPlayerId} roomCode={room.code} />
        </div>
      </div>
    );
  }

  if (myFleet.placement_confirmed) {
    return (
      <div className="stack" style={{ alignItems: "center", width: "min(480px, 100%)" }}>
        <div className="panel stack" style={{ alignItems: "center", textAlign: "center" }}>
          <h2>Fleet confirmed</h2>
          <p className="muted">
            {allReady
              ? "Every fleet is ready. Battle starting..."
              : `Waiting on: ${notReadyTeams.map((t) => teamName(t)).join(", ")}`}
          </p>
          {error && <div className="error-text">{error}</div>}
          <button disabled={saving || allReady} onClick={handleUnconfirm}>
            Edit placement
          </button>
          {isHost && <EndMatchButton roomId={room.id} activeTeamsList={activeTeamsList} />}
          <LeaveMatchButton playerId={myPlayerId} roomCode={room.code} />
        </div>
      </div>
    );
  }

  return (
    <div className="row" style={{ alignItems: "flex-start", justifyContent: "center", gap: "2rem" }}>
      <BoardGrid
        boardSize={boardSize}
        cellVisual={cellVisual}
        onCellClick={handleCellClick}
        onCellHover={setHoverIndex}
        onMouseLeave={() => setHoverIndex(null)}
        label="Place your fleet"
        ships={shipOverlays}
        // Same chrome subtraction as the battle board. maxVw is capped well under the old 92
        // default too: at 92vw the board plus the 220px ship panel and the 2rem gap were wider
        // than the window itself just above the 900px breakpoint, which is a sideways scrollbar.
        maxVh="calc(100vh - 5.5rem)"
        maxVw={62}
      />

      {/* maxHeight, not height: short rosters shouldn't be stretched. Scrolls internally when the
          ship list and roster together outgrow one screen, rather than scrolling the page. */}
      <div
        className="stack battle-sidebar"
        style={{
          minWidth: 220,
          gap: "0.75rem",
          maxHeight: "calc(100vh - 5.5rem)",
          minHeight: 0,
          overflowY: "auto",
        }}
      >
        {activeTeamsList.map((team) => (
          <TeamBox
            key={team}
            team={team}
            players={players}
            shipDefs={shipDefs}
            isMine={team === myTeam}
            myPlayerId={myPlayerId}
          />
        ))}

      <div className="panel stack">
        <h3>Ships</h3>
        {shipDefs.map((def, i) => (
          <div key={i} className="row" style={{ justifyContent: "space-between" }}>
            <button
              onClick={() => setSelectedShip(i)}
              style={{
                flex: 1,
                textAlign: "left",
                borderColor: selectedShip === i ? "var(--accent)" : undefined,
                textDecoration: placedShipIndices.has(i) ? "line-through" : undefined,
                opacity: placedShipIndices.has(i) ? 0.7 : 1,
              }}
            >
              {def.name} ({def.size})
            </button>
            {placedShipIndices.has(i) && (
              <button onClick={() => clearShip(i)} title="Clear">
                ✕
              </button>
            )}
          </div>
        ))}

        <button onClick={() => setHorizontal((h) => !h)}>
          Orientation: {horizontal ? "Horizontal" : "Vertical"} <span className="muted">(R)</span>
        </button>
        <div className="row" style={{ gap: "0.4rem" }}>
          <button style={{ flex: 1 }} onClick={randomize}>
            Randomize
          </button>
          <button style={{ flex: 1 }} onClick={clearAll} disabled={placements.length === 0}>
            Clear all
          </button>
        </div>

        {/* The arrow keys still move the keyboard FOCUS between squares (roving tabindex, for
            anyone not using a mouse) - that behavior stays. It just isn't worth advertising here,
            because "arrow keys move around the board" reads as if it moves your ships. */}
        <span className="muted" style={{ fontSize: "0.7rem", lineHeight: 1.35 }}>
          Click a placed ship to rotate it. <strong>R</strong> flips the selected ship.
        </span>

        {error && <div className="error-text">{error}</div>}

        <button className="primary" disabled={!allPlaced || !allValid || saving} onClick={handleConfirm}>
          Confirm fleet
        </button>
        {isHost && <EndMatchButton roomId={room.id} activeTeamsList={activeTeamsList} />}
        <LeaveMatchButton playerId={myPlayerId} roomCode={room.code} />
      </div>
      </div>
    </div>
  );
}
