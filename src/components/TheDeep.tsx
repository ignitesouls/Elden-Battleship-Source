import { DeepMarkIcon } from "./HitMarkers";
import { cellLabel } from "../lib/battleshipLogic";
import { teamName } from "../lib/teamColors";
import type { DeepMark } from "../lib/deepWater";

/** What to call each thing, in a list where the drawing beside it is only 2rem wide. */
const DEEP_LABEL: Record<DeepMark, string> = {
  whale: "The white whale",
  laboon: "Laboon, who did not mind",
  tentacle: "A tentacle",
  // Same creature, same square: waking is what the last one did, not a different thing to have found.
  sleeper: "A tentacle",
  dutchman: "The Flying Dutchman",
  bottle: "A message in a bottle",
  jar: "Alexander, stuck fast",
  // Same square, same jar - being out is what the second shot did, not a different thing to have found.
  jarFree: "Alexander, out at last",
  igon: "Igon, and his furled finger",
  // Same square, same man - killing Bayle is what got him up, not a different thing to have found.
  igonAvenged: "Igon, tormented no longer",
  patches: 'Patches, who is "sorry"',
};

/**
 * One find, flattened to the few facts the panel prints.
 *
 * Deliberately not `DeepFindRow`: the archive stores this shape and nothing else, so a match read
 * back out of the record books can fill the same panel without the room, the shots or the hiding
 * places - none of which outlive the match by more than an hour.
 */
export interface DeepEntry {
  cellIndex: number;
  mark: DeepMark;
  /** Nickname at the time of the shot, or the team name if they'd already left. */
  who: string;
  /** Null when the archive can't place the finder on a fleet - see matchArchive.deepFromAwards. */
  attackerTeam: number | null;
  /** What this bottle said. Bottles only, and only when it could be recovered - see ArchivedMatch. */
  note?: string | null;
}

/**
 * Where the water gave something up, and who was firing when it did.
 *
 * The counterpart to the marks on the boards below, and it exists because a find is a fact about the
 * ROOM rather than about any one fleet - it is a single square that came back a miss against
 * everybody - while those boards are one per defender. This says it once, with the square named and
 * the finder credited, and it is also the only place a find can appear at all when the fleet whose
 * board would have carried it was already sunk (see MatchReport.deepCellsFor).
 *
 * It lists finds and only finds. The tentacles nobody dug up have no square to print, here or
 * anywhere: `deepWater` works them out from the shots that found them and never resolves a hiding
 * place in advance, so there is no unfound position in this data to leak into a rematch.
 *
 * Shared by the live recap and the archived one. While it lived inside only one of them, the two
 * pages showed different amounts of the same match.
 */
export function TheDeep({
  entries,
  boardSize,
  cthulhu,
}: {
  /** Oldest first - the caller owns the order, since only it knows how the finds were dated. */
  entries: DeepEntry[];
  boardSize: number;
  /** The tally under the list. Omitted when the record doesn't carry one. */
  cthulhu?: { found: number; needed: number; awake: boolean };
}) {
  // Nothing found, nothing to say. Most matches end here, which is the point of the whole hunt.
  if (entries.length === 0) return null;

  return (
    <div className="panel stack" style={{ gap: "0.5rem", width: "min(560px, 100%)" }}>
      <h3 style={{ margin: 0 }}>The Deep</h3>
      {entries.map((entry, i) => (
        // Keyed by position as well as square, because a square can hold more than one find: the
        // Dutchman is met rather than caught, so every crew that fires at his square sights him.
        <div key={`${entry.cellIndex}:${i}`} className="row" style={{ gap: "0.6rem", alignItems: "center" }}>
          {/*
            The marker itself, on a tile of the same blue the board fills a miss with. These drawings
            are positioned absolutely against their square and are built to be read on water - the
            tentacle in particular is a near-black silhouette carried by a pale sheen, which is
            nothing at all on a dark panel. So the list brings the square with it.
          */}
          <span className="deep-find-icon" aria-hidden="true">
            <DeepMarkIcon mark={entry.mark} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong className="display" style={{ color: "var(--accent)" }}>
              {cellLabel(entry.cellIndex, boardSize)}
            </strong>
            <span className="muted"> - </span>
            <strong>{entry.who}</strong>
            {entry.attackerTeam !== null && (
              <span className="muted" style={{ fontSize: "0.8rem" }}> ({teamName(entry.attackerTeam)})</span>
            )}
            <div className="muted" style={{ fontSize: "0.76rem" }}>{DEEP_LABEL[entry.mark]}</div>
            {/* The note is the entire point of the bottle, and until now it only ever existed in a
                toast that had already gone by the time anybody read it. */}
            {entry.mark === "bottle" && entry.note && (
              <div className="display" style={{ fontSize: "0.82rem", color: "var(--accent)" }}>
                &ldquo;{entry.note}&rdquo;
              </div>
            )}
          </span>
        </div>
      ))}
      {cthulhu && cthulhu.needed > 0 && (
        <span className="muted" style={{ fontSize: "0.78rem" }}>
          {cthulhu.awake
            ? `All ${cthulhu.needed} tentacles found. Cthulhu woke.`
            : `${cthulhu.found} of ${cthulhu.needed} tentacles found.`}
        </span>
      )}
    </div>
  );
}
