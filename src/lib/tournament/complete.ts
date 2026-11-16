import { knockoutChampion } from "./bracket";
import type { TournamentFormat } from "./format";
import type { TMatch } from "./types";

const isOpen = (m: TMatch) => m.status === "pending" || m.status === "ready" || m.status === "in_progress";

/**
 * Whether an event's bracket is finished - the condition under which the database moves it to
 * `finished` on its own. Mirrors tournament_is_complete() in the auto-finish migration.
 *
 * It reads the FORMAT as well as the matches, because "nothing left to play" is true at several
 * moments when the event is nowhere near over:
 *   - Swiss draws one round at a time, so after every round there is nothing left to play. It is only
 *     complete once as many rounds have been drawn as the format calls for.
 *   - A qualifier followed by a knockout has nothing left to play the moment the qualifier ends, but
 *     the knockout has not been built yet. It is only complete once the knockout exists and is done.
 *
 *   - The knockout can be built before the group stage ends (see groupSettled in stages.ts), and the
 *     leftover group games are played on for final places. The champion is crowned the moment the
 *     knockout is done (knockoutDone), but the event stays running, so those games can still be played,
 *     until the last of them is decided or dropped (tournament_drop_dead_games).
 *
 * A grand-final reset that was not needed is `skipped`, not open, so it does not hold an event up, and
 * neither does a leftover game dropped at its deadline.
 */
export function tournamentComplete(format: TournamentFormat, matches: TMatch[]): boolean {
  const ofStage = (stage: TMatch["stage"]) => matches.filter((m) => m.stage === stage);

  if (format.knockout) {
    return knockoutDone(matches) && !matches.some((m) => m.stage !== "knockout" && isOpen(m));
  }

  const q = format.qualifier;
  const tiebreakOpen = ofStage("tiebreak").some(isOpen);
  if (q.format === "swiss") {
    const swiss = ofStage("swiss");
    const drawn = swiss.reduce((most, m) => Math.max(most, m.round), 0);
    return q.rounds > 0 && drawn >= q.rounds && !swiss.some(isOpen) && !tiebreakOpen;
  }
  if (q.format === "groups") {
    const groups = ofStage("group");
    return groups.length > 0 && !groups.some(isOpen) && !tiebreakOpen;
  }
  return false;
}

/** The knockout has been built and nothing in it is left to play. */
export function knockoutDone(matches: TMatch[]): boolean {
  const knockout = matches.filter((m) => m.stage === "knockout");
  return knockout.length > 0 && !knockout.some(isOpen);
}

/**
 * The champion the database records: only a knockout has one, and it is crowned as soon as the knockout
 * is done, even while leftover group games keep the event running.
 */
export function eventChampion(format: TournamentFormat, matches: TMatch[]): string | null {
  return format.knockout && knockoutDone(matches) ? knockoutChampion(matches) : null;
}
