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
 * A grand-final reset that was not needed is `skipped`, not open, so it does not hold an event up.
 */
export function tournamentComplete(format: TournamentFormat, matches: TMatch[]): boolean {
  const ofStage = (stage: TMatch["stage"]) => matches.filter((m) => m.stage === stage);

  if (format.knockout) {
    const knockout = ofStage("knockout");
    return knockout.length > 0 && !knockout.some(isOpen);
  }

  const q = format.qualifier;
  if (q.format === "swiss") {
    const swiss = ofStage("swiss");
    const drawn = swiss.reduce((most, m) => Math.max(most, m.round), 0);
    return q.rounds > 0 && drawn >= q.rounds && !swiss.some(isOpen);
  }
  if (q.format === "groups") {
    const groups = ofStage("group");
    return groups.length > 0 && !groups.some(isOpen);
  }
  return false;
}

/** The champion the database records when the bracket finishes the event: only a knockout has one. */
export function eventChampion(format: TournamentFormat, matches: TMatch[]): string | null {
  return format.knockout && tournamentComplete(format, matches) ? knockoutChampion(matches) : null;
}
