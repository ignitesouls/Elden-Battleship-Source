import { MIN_SHOTS_FOR_ACCURACY, type RecordEntry } from "./recordBook";
import { participantKey } from "./careerStats";
import type { FeedShot } from "./attackFeed";
import type { PlayerStats } from "./matchReport";

/**
 * Records being chased right now.
 *
 * The record book is a museum: it says what the best game ever was and nothing about tonight. This is
 * the other half - while a match is running, it works out who is closing on one of those numbers and
 * how far off they are, so the answer arrives while it can still be shouted about.
 *
 * Everything here is a comparison between two things that already exist: the book (built from archived
 * participation rows) and the live scoreboard (built from the attack log by buildPlayerStats). No new
 * storage, and nothing to persist mid-match.
 *
 * Deliberately silent about most of the board. A chase is only reported once somebody is genuinely
 * within reach - see NEAR - because "you are 14 hits off the record" is not news, and a panel that
 * lists every player against every record is a table nobody reads.
 */

export interface RecordChase {
  recordId: string;
  emoji: string;
  label: string;
  /** Whose chase this is - the /player/:key link target, and the identity for de-duping. */
  key: string;
  nickname: string;
  team: number;
  /** Where they are now, in the record's own units. */
  current: number;
  /** The standing record. */
  record: number;
  /** Who holds it, for "one behind Aljex". */
  holder: string;
  state: "chasing" | "broken";
  /** "2 hits off Aljex's 19 hits" / "13 hits - a new record". */
  display: string;
  /** Distance left, scaled by what counts as near for this record. 0 means it has fallen. */
  closeness: number;
}

/**
 * How close counts as a chase.
 *
 * Three for the counting records is about one good salvo - near enough that the next shot matters. One
 * for streaks, which are small numbers where being "three off" means nothing. Accuracy is five points,
 * and only once a few shots are down, because before that the number swings wildly on every shot.
 */
const NEAR = { count: 3, streak: 1, accuracy: 0.05 };

/** The live scoreboard, plus the two things it doesn't carry. */
export interface LiveTally {
  key: string;
  nickname: string;
  team: number;
  shots: number;
  hits: number;
  sunk: number;
  accuracy: number;
  /** Longest run of connecting shots so far. */
  streak: number;
}

/**
 * Longest hit streak per player, from the live shot log.
 *
 * The archived twin of this lives in recordBook (see hitStreaks), and they are deliberately separate
 * functions rather than one generic one: this reads grouped `attacks`, that reads `match_events`, and
 * the two row shapes have nothing in common but the idea. Merging them would mean a shape that fits
 * neither well.
 *
 * Unresolved shots are skipped rather than counted as misses - a shot still in the air has not broken
 * anything yet.
 */
function liveStreaks(shots: FeedShot[]): Map<string, number> {
  const best = new Map<string, number>();
  const run = new Map<string, number>();

  // groupIntoShots is newest-first; a streak is only meaningful in the order it happened.
  for (const shot of [...shots].reverse()) {
    const attacker = shot.rows[0];
    const key = attacker.attacker_player_id ?? `team:${shot.attackerTeam}`;
    if (shot.rows.every((r) => r.result === "pending")) continue;

    const connected = shot.rows.some((r) => r.result === "hit" || r.result === "sunk");
    const next = connected ? (run.get(key) ?? 0) + 1 : 0;
    run.set(key, next);
    if (next > (best.get(key) ?? 0)) best.set(key, next);
  }
  return best;
}

/** The live tallies for a match in progress, keyed the way the record book keys people. */
export function liveTallies(stats: PlayerStats[], shots: FeedShot[], userIdFor: (playerId: string | null) => string | null): LiveTally[] {
  const streaks = liveStreaks(shots);
  return stats.map((s) => ({
    // Matches the book's grouping, so a signed-in player chases their own record rather than a
    // stranger's - and a guest is grouped by nickname exactly as the book groups them.
    key: participantKey({ user_id: userIdFor(s.playerId), nickname: s.nickname }),
    nickname: s.nickname,
    team: s.team,
    shots: s.shots,
    hits: s.hits,
    sunk: s.sunk,
    accuracy: s.accuracy,
    streak: streaks.get(s.playerId ?? `team:${s.team}`) ?? 0,
  }));
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** One record's live comparison: how a tally is measured against it, and how that reads. */
interface Track {
  id: string;
  value: (t: LiveTally) => number;
  /** False when this tally isn't eligible at all (accuracy before the shot floor). */
  eligible?: (t: LiveTally) => boolean;
  near: number;
  units: (n: number) => string;
  /**
   * How the REMAINING distance reads, which is not always the record's own unit.
   *
   * A streak is measured in "5 in a row" but closed by landing hits, so "1 in a row off" is wrong and
   * "1 hit off" is what a player needs to hear. Accuracy is a percentage but closed in points.
   */
  gapUnits?: (n: number) => string;
}

/**
 * Which records get chased live. Opt-in, and short on purpose.
 *
 * The timing records are absent because they are set the moment they happen and there is no closing
 * on them. "Rarest honor" is absent for a stronger version of the same reason: honors are not handed
 * out until the match is over, so mid-match there is no number to compare against - and the one that
 * arrives at the end arrives with the recap, which announces it far better than a chase panel could.
 * "Worst accuracy" is absent for a different reason again: it is a joke that lands in the record
 * book, read after the fact, and would not land at all as a live callout telling somebody in front
 * of an audience that they are two points off the worst game ever played. Leave it out.
 */
const TRACKS: Track[] = [
  { id: "hits", value: (t) => t.hits, near: NEAR.count, units: (n) => plural(n, "hit") },
  { id: "sunk", value: (t) => t.sunk, near: NEAR.count, units: (n) => plural(n, "ship") },
  { id: "shots", value: (t) => t.shots, near: NEAR.count, units: (n) => plural(n, "shot") },
  {
    id: "streak",
    value: (t) => t.streak,
    near: NEAR.streak,
    units: (n) => `${n} in a row`,
    gapUnits: (n) => plural(n, "hit"),
  },
  {
    id: "accuracy",
    value: (t) => t.accuracy,
    eligible: (t) => t.shots >= MIN_SHOTS_FOR_ACCURACY,
    near: NEAR.accuracy,
    units: (n) => `${Math.round(n * 100)}%`,
    gapUnits: (n) => `${Math.round(n * 100)} points`,
  },
];

/**
 * Who is closing on a record, and who has just taken one.
 *
 * @param book the record book for this board, as the Leaderboard builds it.
 * @param tallies the live scoreboard, from `liveTallies`.
 * @param viewerTeam a player's team, to see only their own crew's chases; omit for a caster, who sees
 * every fleet's. Same rule as the things hiding in the water - see lib/deepWater.
 *
 * Broken records sort to the top, then whoever is nearest. One chase per record: two crewmates both
 * three hits off is one thing worth saying, not two.
 */
export function recordChases(book: RecordEntry[], tallies: LiveTally[], viewerTeam?: number | null): RecordChase[] {
  const out: RecordChase[] = [];
  const mine = (t: LiveTally) => viewerTeam === undefined || viewerTeam === null || t.team === viewerTeam;

  for (const track of TRACKS) {
    const entry = book.find((r) => r.id === track.id);
    // A record nobody holds yet can't be chased - the first person to qualify simply sets it.
    if (!entry?.holder) continue;
    const record = entry.holder.value;

    const contenders = tallies
      .filter((t) => mine(t) && (track.eligible?.(t) ?? true))
      .map((t) => ({ tally: t, current: track.value(t) }))
      // Strictly greater, because the book gives a tie to whoever got there first.
      .filter((c) => c.current > record || record - c.current <= track.near)
      .sort((a, b) => b.current - a.current);

    const best = contenders[0];
    if (!best || best.current <= 0) continue;

    const broken = best.current > record;
    const gap = record - best.current;
    out.push({
      recordId: track.id,
      emoji: entry.emoji,
      label: entry.label,
      key: best.tally.key,
      nickname: best.tally.nickname,
      team: best.tally.team,
      current: best.current,
      record,
      holder: entry.holder.nickname,
      state: broken ? "broken" : "chasing",
      display: broken
        ? `${track.units(best.current)} - a new record`
        : gap <= 0
          ? `level with the record (${track.units(record)})`
          : `${(track.gapUnits ?? track.units)(gap)} off ${entry.holder.nickname}'s ${track.units(record)}`,
      // Closeness as a fraction of what counts as near for THIS record, so a 3-point accuracy chase
      // and a 2-hit chase can be ordered against each other at all.
      closeness: gap / track.near,
    });
  }

  return out.sort(
    (a, b) => Number(b.state === "broken") - Number(a.state === "broken") || a.closeness - b.closeness
  );
}
