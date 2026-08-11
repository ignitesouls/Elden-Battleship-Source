import { cellFromLabel } from "./battleshipLogic";
import { finalFinds, type DeepMark, type DeepWater } from "./deepWater";
import type { Award, PlayerStats } from "./matchReport";

/**
 * What the water gave up, written down so it outlives the match.
 *
 * The finds are derived from `deep_hides`, and those rows are deleted with the room about an hour
 * after it goes quiet - so unless they are copied into the archive at the end of the match, a recap
 * read back out of the Almanac has honors naming the Flying Dutchman and a board with nothing on it.
 * That is exactly what it had, for every match archived before this file existed.
 *
 * Everything here is pure, and deliberately knows nothing about Supabase: lib/matchArchive owns the
 * reading and lib/archiveMatch owns the writing, and scripts/check-deep-water.ts can run the whole
 * round trip in bare Node.
 */

/**
 * One find, as the archive keeps it.
 *
 * The same few facts the recap's panel prints, and nothing that could be worked backwards into a
 * hiding place: only squares somebody actually found are ever written. A tentacle nobody fired at is
 * not in `DeepWater` to begin with - it was never readable by any client - so the archive cannot
 * become the one place a match's unfound squares survive.
 */
export interface ArchivedDeepFind {
  cellIndex: number;
  mark: DeepMark;
  /** Nickname at the time of the shot, or the team name if they'd already left. */
  who: string;
  /** Null only on a find recovered from honor text whose finder isn't on the archived scoreboard. */
  attackerTeam: number | null;
  /** ISO timestamp of the shot. Null on finds recovered from honor text, which carries no clock. */
  at?: string | null;
  /** What this bottle said, quoted at write time. Bottles only. */
  note?: string | null;
}

/** What one match turned up in the water, as stored in `match_reports.summary`. */
export interface ArchivedDeep {
  finds: ArchivedDeepFind[];
  cthulhu?: { found: number; needed: number; awake: boolean };
}

/**
 * A finished match's finds, flattened for storage.
 *
 * The note travels with the bottle rather than being reseeded on the way out. It is drawn from the
 * room id and the square, both of which the archive does keep for recent matches - but quoting it
 * here is what makes it certain rather than usually, and it costs one string.
 */
export function deepForArchive(deep: DeepWater, note: (cellIndex: number) => string): ArchivedDeep {
  return {
    finds: finalFinds(deep).map(({ find, mark }) => ({
      cellIndex: find.cellIndex,
      mark,
      who: find.who,
      attackerTeam: find.attackerTeam,
      at: find.at,
      note: mark === "bottle" ? note(find.cellIndex) : null,
    })),
    cthulhu: {
      found: deep.cthulhu.tentacles.length,
      needed: deep.cthulhu.needed,
      awake: deep.cthulhu.awake,
    },
  };
}

/**
 * The finds that can be read back out of the honors, for matches archived before they were stored.
 *
 * A salvage job, and worth doing because the alternative is nothing at all: for those matches the
 * honor text is the last surviving record of where anything was found. Four of the honors happen to
 * name their square, and they name it with `cellLabel`, so the square comes back exactly.
 *
 * Matched on the DETAIL rather than the title, because titles have been renamed in place before
 * (supabase/maintenance/rename_honor_titles.sql) and the sentence describing the deed has not.
 *
 * What it cannot recover is anything whose honor doesn't name a square - Laboon, Patches, the
 * tentacle rungs, second and third Dutchman sightings - or any find whose honor went unawarded under
 * the one-honor-per-player cascade. So this is explicitly a partial list, and the page that draws it
 * says so.
 */
const SALVAGEABLE: Array<{ mark: DeepMark; pattern: RegExp }> = [
  { mark: "whale", pattern: /found the white whale at ([A-R]\d{1,2})/ },
  { mark: "dutchman", pattern: /sighted a sail at ([A-R]\d{1,2}) with nothing under it/ },
  // The only one carrying a second capture: the note is quoted in the honor, which is the sole
  // reason a bottle from an old match can still say what it said.
  { mark: "bottle", pattern: /fished a bottle out of the sea at ([A-R]\d{1,2})\. It said "(.*)"/ },
  { mark: "jar", pattern: /turned up a warrior jar at ([A-R]\d{1,2}), wedged fast/ },
];

/**
 * Alexander got out.
 *
 * Not salvageable as a find on its own: the square named in THIS honor is the shot that landed
 * beside him, not the one he was wedged in. All it can do is settle which way his own square is
 * drawn, and only when the other honor named that square.
 */
const FREED_ALEXANDER = /shot Alexander loose from ([A-R]\d{1,2})/;

export function deepFromAwards(
  awards: Award[],
  stats: PlayerStats[],
  boardSize: number
): ArchivedDeepFind[] {
  const teamOf = new Map(stats.map((s) => [s.nickname, s.team]));
  const freed = awards.some((a) => FREED_ALEXANDER.test(a.detail));
  const finds: ArchivedDeepFind[] = [];

  for (const award of awards) {
    for (const { mark, pattern } of SALVAGEABLE) {
      const parsed = pattern.exec(award.detail);
      if (!parsed) continue;
      const cellIndex = cellFromLabel(parsed[1], boardSize);
      if (cellIndex !== null) {
        finds.push({
          cellIndex,
          // His square is drawn for whether he is still in there, which the other honor settles.
          mark: mark === "jar" && freed ? "jarFree" : mark,
          who: award.nickname,
          attackerTeam: teamOf.get(award.nickname) ?? null,
          at: null,
          note: mark === "bottle" ? (parsed[2] ?? null) : null,
        });
      }
      break;
    }
  }

  // Left in honors order, which is by rarity. There are no timestamps on any of these, and inventing
  // a chronology would be the one thing worse than admitting there isn't one.
  return finds;
}
