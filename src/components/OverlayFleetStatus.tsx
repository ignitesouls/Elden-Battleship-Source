import type { ShipDefinition } from "../types/battleship";
import { shipArtUrl } from "../lib/shipArt";

interface Props {
  teamLabel: string;
  colorHex: string;
  shipDefs: ShipDefinition[];
  /** Names of this team's hulls confirmed sunk, straight from the public attack log. */
  sunkNames: string[];
  /** Marks the streamer's own fleet. */
  isMine?: boolean;
}

/**
 * A team's fleet drawn as its actual ship silhouettes rather than an "n/m" counter.
 *
 * Sunk hulls are grayed and struck through with the same red the board uses for a wreck, so a
 * viewer can see at a glance which classes are gone - "they've lost the Carrier" is a much more
 * useful thing to read off a stream than "3/5".
 */
export function OverlayFleetStatus({ teamLabel, colorHex, shipDefs, sunkNames, isMine }: Props) {
  const sunk = sunkFlags(shipDefs, sunkNames);
  const afloat = sunk.filter((s) => !s).length;

  return (
    <div className={`ov-fleet${isMine ? " ov-fleet-mine" : ""}`}>
      <div className="ov-fleet-head">
        <span className="ov-team-name" style={{ color: colorHex }}>
          {teamLabel}
        </span>
        <span className={`ov-afloat${afloat === 0 ? " ov-dead" : ""}`}>
          {afloat}/{shipDefs.length}
        </span>
      </div>
      <div className="ov-fleet-ships">
        {shipDefs.map((def, i) => (
          <span
            key={i}
            className={`ov-fleet-ship${sunk[i] ? " ov-fleet-ship-sunk" : ""}`}
            title={`${def.name}${sunk[i] ? " - sunk" : ""}`}
            style={{
              // Width tracks hull length so a Carrier reads as the big one, exactly as on the board.
              //
              // Through a variable rather than a bare px so a consumer can rescale the whole fleet
              // by setting one number - the scorebug wants these about twice HUD size, and doing
              // that with a transform would leave every hull's laid-out width unchanged and need a
              // different margin correction per ship length. See --ov-ship-unit in OverlayTimer.css.
              width: `calc(${def.size} * var(--ov-ship-unit, 9px))`,
              maskImage: `url(${shipArtUrl(def.name, def.size)})`,
              WebkitMaskImage: `url(${shipArtUrl(def.name, def.size)})`,
              backgroundColor: sunk[i] ? "#6b2020" : colorHex,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Which hull in the list each sunk report refers to.
 *
 * Consumes one entry per report rather than matching on name alone: the Armada preset fields two
 * Cruisers and two Destroyers, and a plain `sunkNames.includes(def.name)` would black out both the
 * moment either one went down.
 */
function sunkFlags(shipDefs: ShipDefinition[], sunkNames: string[]): boolean[] {
  const remaining = new Map<string, number>();
  for (const name of sunkNames) remaining.set(name, (remaining.get(name) ?? 0) + 1);

  return shipDefs.map((def) => {
    const left = remaining.get(def.name) ?? 0;
    if (left <= 0) return false;
    remaining.set(def.name, left - 1);
    return true;
  });
}
