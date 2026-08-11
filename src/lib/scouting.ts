/**
 * Scouting reports: what kind of captain each player is, measured against the rest of the field.
 *
 * Every number here comes from rows the archive already holds - `match_participants` for records and
 * totals, `match_events` for timing and per-shot detail. Nothing new is stored.
 *
 * The load-bearing decision in this file is that it REFUSES to characterise a player it hasn't seen
 * enough of. A trait like "Sharpshooter" is a claim about a tendency, and a tendency cannot be read
 * off two matches - at that sample the top of any leaderboard is whoever got lucky. So traits,
 * ranks and "vs field" deltas only appear once both the player and the field clear a threshold, and
 * until then a card shows counting stats and says plainly that it's too early. The reports still
 * compute, so the moment the record books are deep enough the cards fill in on their own.
 *
 * Rates are always pooled - total hits over total shots - never an average of per-match rates,
 * which would let a lucky two-shot game weigh as much as a forty-shot slog.
 */
// Extension spelled out - and careerStats imports nothing itself - so this module can be run
// straight from bare Node by scripts/check-scouting.ts, the way check-boards.ts runs the board
// builder. The events import is type-only and erases, so it costs nothing here.
import { participantKey, type ParticipantRow } from "./careerStats.ts";
import type { MatchEventRow } from "./almanac";

/** Matches a player needs before anything comparative is said about them. */
export const MIN_MATCHES_FOR_TRAITS = 4;
/** Qualified players the field needs before it can be a baseline to compare against at all. */
export const MIN_FIELD_SIZE = 4;

export type Confidence = "unrated" | "low" | "medium" | "high";

/** Which direction is good, so "above field" can mean "better" for both accuracy and pace. */
type Direction = "higher" | "lower";

/**
 * Every metric here is a shooting metric.
 *
 * Nothing is measured from where a fleet was hidden. One captain places for the whole team, usually
 * by pressing Randomize, so how long a fleet survives is a fact about the shuffle and about whoever
 * was firing at it - not about the players standing behind it. Crediting a captain for a fleet the
 * RNG hid well would be the most flattering number on the card and the least earned.
 */
export type MetricId =
  | "winRate"
  | "accuracy"
  | "shotsPerMatch"
  | "sinkConversion"
  | "firstBloodRate"
  | "pace";

export interface MetricDef {
  id: MetricId;
  label: string;
  better: Direction;
  /** How to render one value. */
  format: (value: number) => string;
  blurb: string;
}

export const METRICS: MetricDef[] = [
  {
    id: "winRate",
    label: "Win rate",
    better: "higher",
    format: (v) => `${Math.round(v * 100)}%`,
    blurb: "Share of decided matches won",
  },
  {
    id: "accuracy",
    label: "Accuracy",
    better: "higher",
    format: (v) => `${Math.round(v * 100)}%`,
    blurb: "Shots that struck a hull",
  },
  {
    id: "shotsPerMatch",
    label: "Shots per match",
    better: "higher",
    format: (v) => v.toFixed(1),
    blurb: "How much of the shooting this captain does",
  },
  {
    id: "sinkConversion",
    label: "Sinkings per hit",
    better: "higher",
    format: (v) => v.toFixed(2),
    blurb: "How often a hit is the one that finishes a hull - following damage up rather than leaving it",
  },
  {
    id: "firstBloodRate",
    label: "First blood rate",
    better: "higher",
    format: (v) => `${Math.round(v * 100)}%`,
    blurb: "Matches where this captain landed the opening hit",
  },
  {
    id: "pace",
    label: "Square pace",
    better: "lower",
    format: (v) => `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, "0")}/shot`,
    blurb: "Mean time between their own shots - lower is faster",
  },
];

export interface MetricReading {
  id: MetricId;
  value: number | null;
  /** Sample the value rests on - shots, matches, whatever the metric counts. */
  sample: number;
  /** The field's pooled value, or null when the field is too thin to be a baseline. */
  field: number | null;
  /** Signed distance from the field in spreads: positive is always better. Null when unrated. */
  edge: number | null;
  /** 1-based position among qualified players, best first. Null when unrated. */
  rank: number | null;
  rankOf: number | null;
}

export interface Trait {
  name: string;
  /** The reading that earned it, for the tooltip. */
  metric: MetricId;
  blurb: string;
}

export interface ScoutingReport {
  key: string;
  nickname: string;
  userId: string | null;
  verified: boolean;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  confidence: Confidence;
  /** True when this player has enough matches to be characterised at all. */
  rated: boolean;
  readings: Record<MetricId, MetricReading>;
  /** The headline traits, strongest first. Empty until rated. */
  traits: Trait[];
  /** Everything else they're above the field on. */
  supporting: Trait[];
  /** One sentence for the top of the card. */
  summary: string;
  lastPlayed: string | null;
}

/** Trait names, one per metric. Battleship's own, not bingo's - and all about the shooting. */
const TRAIT_NAMES: Record<MetricId, string> = {
  winRate: "Winner",
  accuracy: "Sharpshooter",
  shotsPerMatch: "Barrage Captain",
  sinkConversion: "Hull Breaker",
  firstBloodRate: "Opening Aggressor",
  pace: "Blitz Gunner",
};

/** Population standard deviation. The field IS the population here - there is no wider one. */
function spread(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((n, v) => n + v, 0) / values.length;
  return Math.sqrt(values.reduce((n, v) => n + (v - mean) ** 2, 0) / values.length);
}

interface Tally {
  key: string;
  nickname: string;
  userId: string | null;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  decided: number;
  shots: number;
  hits: number;
  sunk: number;
  lastPlayed: string | null;
  /** Matches that had an opening hit at all, and how many of those this player landed. */
  firstBloodChances: number;
  firstBloods: number;
  /** Mean seconds between their own shots, per match, pooled. */
  paceSpans: number[];
}

function emptyTally(key: string, row: ParticipantRow): Tally {
  return {
    key,
    nickname: row.nickname,
    userId: row.user_id,
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    decided: 0,
    shots: 0,
    hits: 0,
    sunk: 0,
    lastPlayed: null,
    firstBloodChances: 0,
    firstBloods: 0,
    paceSpans: [],
  };
}

function groupBy<T, K>(list: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of list) {
    const k = keyOf(item);
    const l = m.get(k);
    if (l) l.push(item);
    else m.set(k, [item]);
  }
  return m;
}

function confidenceFor(matches: number): Confidence {
  if (matches < MIN_MATCHES_FOR_TRAITS) return "unrated";
  if (matches < 6) return "low";
  if (matches < 10) return "medium";
  return "high";
}

/**
 * One report per player, over the rows handed in.
 *
 * Callers filter to a single square set first - an objectives-board accuracy and a boss-board
 * accuracy describe different games, and pooling them describes neither.
 */
export function buildScoutingReports(
  participants: ParticipantRow[],
  events: MatchEventRow[]
): ScoutingReport[] {
  const tallies = new Map<string, Tally>();
  const partsByMatch = groupBy(participants, (p) => p.match_key);
  const eventsByMatch = groupBy(events, (e) => e.match_key);

  for (const row of participants) {
    const key = participantKey(row);
    let t = tallies.get(key);
    if (!t) {
      t = emptyTally(key, row);
      tallies.set(key, t);
    }

    t.matches++;
    if (row.draw) t.draws++;
    else if (row.won) {
      t.wins++;
      t.decided++;
    } else {
      t.losses++;
      t.decided++;
    }
    t.shots += row.shots;
    t.hits += row.hits;
    t.sunk += row.sunk;
    if (!t.lastPlayed || row.finished_at > t.lastPlayed) {
      t.lastPlayed = row.finished_at;
      t.nickname = row.nickname; // a rename should show the current name
    }
  }

  // First blood is per match, and belongs to the individual who fired the shot.
  for (const [matchKey, evs] of eventsByMatch) {
    const timed = evs.filter((e) => e.match_seconds !== null);
    const opener = [...timed]
      .sort((a, b) => (a.match_seconds as number) - (b.match_seconds as number))
      .find((e) => e.result === "hit" || e.result === "sunk");
    if (!opener) continue;

    // Everyone who was in the match had the chance at it, whether they are in the event log or not.
    for (const p of partsByMatch.get(matchKey) ?? []) {
      const t = tallies.get(participantKey(p));
      if (!t) continue;
      t.firstBloodChances++;
      if (participantKey(opener) === t.key) t.firstBloods++;
    }
  }

  // Pace, per match then pooled: elapsed time over that player's own shots WITHIN a match, so the
  // days between sessions never get counted as thinking time.
  for (const evs of eventsByMatch.values()) {
    for (const own of groupBy(evs, (e) => participantKey(e)).values()) {
      const t = tallies.get(participantKey(own[0]));
      if (!t) continue;
      const ordered = own
        .filter((e) => e.match_seconds !== null)
        .sort((a, b) => (a.match_seconds as number) - (b.match_seconds as number));
      // One shot has no interval to measure.
      if (ordered.length < 2) continue;
      const first = ordered[0].match_seconds as number;
      const last = ordered[ordered.length - 1].match_seconds as number;
      t.paceSpans.push((last - first) / (ordered.length - 1));
    }
  }

  const raw = [...tallies.values()];

  /** The player's own value for a metric, with the sample it rests on. */
  function valueOf(t: Tally, id: MetricId): { value: number | null; sample: number } {
    switch (id) {
      case "winRate":
        return { value: t.decided > 0 ? t.wins / t.decided : null, sample: t.decided };
      case "accuracy":
        return { value: t.shots > 0 ? t.hits / t.shots : null, sample: t.shots };
      case "shotsPerMatch":
        return { value: t.matches > 0 ? t.shots / t.matches : null, sample: t.matches };
      case "sinkConversion":
        return { value: t.hits > 0 ? t.sunk / t.hits : null, sample: t.hits };
      case "firstBloodRate":
        return {
          value: t.firstBloodChances > 0 ? t.firstBloods / t.firstBloodChances : null,
          sample: t.firstBloodChances,
        };
      case "pace":
        return {
          value: t.paceSpans.length > 0 ? t.paceSpans.reduce((n, v) => n + v, 0) / t.paceSpans.length : null,
          sample: t.paceSpans.length,
        };
    }
  }

  // The baseline is the qualified players only. Including one-match cameos would drag the field
  // toward whoever happened to show up once, which is exactly the noise the threshold is for.
  const qualified = raw.filter((t) => t.matches >= MIN_MATCHES_FOR_TRAITS);
  const fieldReady = qualified.length >= MIN_FIELD_SIZE;

  /** Pooled field value, computed from the qualified players' totals rather than their rates. */
  function fieldValue(id: MetricId): number | null {
    if (!fieldReady) return null;
    const sum = (pick: (t: Tally) => number) => qualified.reduce((n, t) => n + pick(t), 0);
    switch (id) {
      case "winRate": {
        const decided = sum((t) => t.decided);
        return decided > 0 ? sum((t) => t.wins) / decided : null;
      }
      case "accuracy": {
        const shots = sum((t) => t.shots);
        return shots > 0 ? sum((t) => t.hits) / shots : null;
      }
      case "shotsPerMatch": {
        const matches = sum((t) => t.matches);
        return matches > 0 ? sum((t) => t.shots) / matches : null;
      }
      case "sinkConversion": {
        const hits = sum((t) => t.hits);
        return hits > 0 ? sum((t) => t.sunk) / hits : null;
      }
      case "firstBloodRate": {
        const chances = sum((t) => t.firstBloodChances);
        return chances > 0 ? sum((t) => t.firstBloods) / chances : null;
      }
      case "pace": {
        const spans = qualified.flatMap((t) => t.paceSpans);
        return spans.length > 0 ? spans.reduce((n, v) => n + v, 0) / spans.length : null;
      }
    }
  }

  // Spread across the qualified field, per metric, so an edge means "unusual here" rather than
  // "far from the mean in units nobody can interpret".
  const fields = new Map<MetricId, number | null>();
  const spreads = new Map<MetricId, number>();
  const ranked = new Map<MetricId, string[]>();
  for (const def of METRICS) {
    fields.set(def.id, fieldValue(def.id));
    const withValue = qualified
      .map((t) => ({ key: t.key, value: valueOf(t, def.id).value }))
      .filter((x): x is { key: string; value: number } => x.value !== null);
    spreads.set(def.id, spread(withValue.map((x) => x.value)));
    ranked.set(
      def.id,
      withValue
        .sort((a, b) => (def.better === "higher" ? b.value - a.value : a.value - b.value))
        .map((x) => x.key)
    );
  }

  const reports: ScoutingReport[] = raw.map((t) => {
    const rated = fieldReady && t.matches >= MIN_MATCHES_FOR_TRAITS;
    const readings = {} as Record<MetricId, MetricReading>;

    for (const def of METRICS) {
      const { value, sample } = valueOf(t, def.id);
      const field = fields.get(def.id) ?? null;
      const sd = spreads.get(def.id) ?? 0;
      const order = ranked.get(def.id) ?? [];
      const position = order.indexOf(t.key);

      // Edge is signed so that positive always means better, whichever way the metric runs. With no
      // spread to divide by there is no edge to report - everyone is at the same value.
      const edge =
        rated && value !== null && field !== null && sd > 0
          ? (def.better === "higher" ? value - field : field - value) / sd
          : null;

      readings[def.id] = {
        id: def.id,
        value,
        sample,
        field,
        edge,
        rank: rated && position >= 0 ? position + 1 : null,
        rankOf: rated && position >= 0 ? order.length : null,
      };
    }

    // A trait needs a real gap from the field, not merely the right side of it. Half a spread is
    // the smallest gap that still means something at these sample sizes.
    const earned = METRICS.filter((def) => (readings[def.id].edge ?? 0) >= 0.5)
      .sort((a, b) => (readings[b.id].edge ?? 0) - (readings[a.id].edge ?? 0))
      .map((def) => ({ name: TRAIT_NAMES[def.id], metric: def.id, blurb: def.blurb }));

    const traits = earned.slice(0, 2);
    const supporting = earned.slice(2);

    return {
      key: t.key,
      nickname: t.nickname,
      userId: t.userId,
      verified: Boolean(t.userId),
      matches: t.matches,
      wins: t.wins,
      losses: t.losses,
      draws: t.draws,
      confidence: confidenceFor(t.matches),
      rated,
      readings,
      traits,
      supporting,
      summary: summaryFor(t, traits, rated, fieldReady),
      lastPlayed: t.lastPlayed,
    };
  });

  return reports.sort(
    (a, b) => b.matches - a.matches || b.wins - a.wins || a.nickname.localeCompare(b.nickname)
  );
}

/**
 * The sentence at the top of a card.
 *
 * Says what the sample supports and no more. An unrated captain gets told they're unrated rather
 * than handed a characterisation the record books can't back.
 */
function summaryFor(t: Tally, traits: Trait[], rated: boolean, fieldReady: boolean): string {
  const games = `${t.matches} ${t.matches === 1 ? "match" : "matches"}`;
  if (!fieldReady) {
    return `${games} on record. Too few captains have played enough for anyone to be measured against the field yet.`;
  }
  if (!rated) {
    return `${games} on record - ${MIN_MATCHES_FOR_TRAITS} are needed before a read on this captain means anything.`;
  }
  if (traits.length === 0) {
    return `A captain with no pronounced lean: close to the field on everything measured, across ${games}.`;
  }
  if (traits.length === 1) {
    return `${traits[0].name} - ${traits[0].blurb.toLowerCase()}. Read from ${games}.`;
  }
  return `${traits[0].name} who also stands out for ${traits[1].blurb.toLowerCase()}. Read from ${games}.`;
}

/** How many more matches this player needs before their card can say anything comparative. */
export function matchesUntilRated(report: ScoutingReport): number {
  return Math.max(0, MIN_MATCHES_FOR_TRAITS - report.matches);
}
