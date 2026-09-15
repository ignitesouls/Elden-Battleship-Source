import type { ShipDefinition } from "../types/battleship";
import { shipArtUrl } from "../lib/shipArt";
import { fleetByLength } from "../lib/fleetOrder";
import { useT } from "../lib/language";

interface Props {
  teamLabel: string;
  colorHex: string;
  shipDefs: ShipDefinition[];
  /** One flag per entry in `shipDefs`, true where that hull is down. See lib/battleshipLogic. */
  sunkHulls: boolean[];
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
export function OverlayFleetStatus({ teamLabel, colorHex, shipDefs, sunkHulls, isMine }: Props) {
  const t = useT();
  const sunk = sunkHulls;
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
      {/* Longest hull first rather than dealt order - see lib/fleetOrder. It matters more here than
          on the roster it matches: these are silhouettes, so a sorted strip is a staircase that
          shortens as the fleet dies, while the dealt order of a busy preset interleaves the lengths
          and leaves a viewer counting shapes to work out what is left. */}
      <div className="ov-fleet-ships">
        {fleetByLength(shipDefs).map(({ def, index: i }) => (
          <span
            key={i}
            className={`ov-fleet-ship${sunk[i] ? " ov-fleet-ship-sunk" : ""}`}
            title={`${def.name} - ${def.size}${sunk[i] ? t(", sunk", ", coulé") : ""}`}
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

/*
 * The name-matching this file used to do lives in lib/battleshipLogic.sunkHullFlags now, keyed on
 * where each hull was rather than on how many reports carried its name.
 *
 * Consuming one entry per report already survived the Armada's two Cruisers, which was what it was
 * written for. What it could not survive was the same hull being reported twice - a second shot at
 * a settled square copies the first verdict, geometry and all - which spent the extra report on a
 * hull nobody had touched. Every roster in the app now answers this question the same way.
 */
