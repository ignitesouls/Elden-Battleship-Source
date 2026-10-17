import type { KnockoutOptions } from "./bracket";
import { groupLabel } from "./groupNames";
import { dealGroups } from "./groups";
import { recommendedSwissRounds } from "./swiss";

/**
 * What an event looks like from the organizer's chair: an optional qualifier, then an optional
 * knockout. Stored as JSON on the tournament, so it stays a plain data shape.
 *
 *   qualifier none   - straight into the knockout with everybody
 *   qualifier swiss  - N rounds, then the top `cutTo` go through
 *   qualifier groups - round-robin groups, then the top `advancePerGroup` of each go through
 *   knockout null    - the qualifier is the whole event and its table decides the winner
 *
 * A group stage exists to seed the knockout, so a group format never says how many teams to cut to -
 * it says how many to take from each group, and the total follows from that. Making the organizer
 * type the total as well would just be a second number that has to agree with the first.
 *
 * Groups need not be alike. A CHALLENGER group holds newer teams, put there by hand so they play each
 * other rather than being fed to the strongest, and it usually sends fewer to the knockout - two from
 * the challenger group and three from each main group, say. Challenger qualifiers are seeded below
 * every main-group qualifier (see seedFromGroups).
 */
export interface GroupPool {
  /** Teams this group sends to the knockout. */
  advance: number;
  challenger: boolean;
}

export type GroupsQualifier = {
  format: "groups";
  groupCount: number;
  /** Teams taken from each group. Required once there is a knockout to take them to. */
  advancePerGroup?: number;
  /**
   * Per group, by group number, overriding advancePerGroup. Absent on events made before groups could
   * differ, which read as every group sending advancePerGroup and none being a challenger.
   */
  pools?: GroupPool[];
  /** Team id -> group number, for teams the organizer put in a group by hand. See dealGroups. */
  placement?: Record<string, number>;
  legs: 1 | 2;
  bestOf: number;
};

export type QualifierConfig =
  | { format: "none" }
  | { format: "swiss"; rounds: number; bestOf: number }
  | GroupsQualifier;

export interface KnockoutConfig extends KnockoutOptions {
  /**
   * How many entrants reach the knockout after a Swiss qualifier. Ignored when everybody goes (no
   * qualifier) and when the groups decide it (advancePerGroup).
   */
  cutTo?: number;
}

export interface TournamentFormat {
  qualifier: QualifierConfig;
  knockout: KnockoutConfig | null;
}

/** The group count, or 0 while the box holds something that is not one. */
const groupCountOf = (q: GroupsQualifier) => (Number.isInteger(q.groupCount) && q.groupCount > 0 ? Math.min(q.groupCount, 512) : 0);

/** Every group's settings, one per group, whichever way the format was saved. */
export function groupPools(q: GroupsQualifier): GroupPool[] {
  return Array.from({ length: groupCountOf(q) }, (_, g) => ({
    advance: q.pools?.[g]?.advance ?? q.advancePerGroup ?? 0,
    challenger: q.pools?.[g]?.challenger ?? false,
  }));
}

/** The groups for these entrants (best seed first): hand placements honoured, the rest dealt by seed. */
export function groupsFor(q: GroupsQualifier, seeded: string[]): string[][] {
  return dealGroups(seeded, groupCountOf(q), { placement: q.placement, challenger: groupPools(q).map((p) => p.challenger) });
}

/**
 * How many teams each group will hold for a field of `n`. Only the NUMBER placed in each group matters
 * to the sizes, so this works from the placement alone - which assumes it names only teams still in the
 * event (see prunePlacement).
 */
export function groupSizes(q: GroupsQualifier, n: number): number[] {
  const count = groupCountOf(q);
  const placed = Object.values(q.placement ?? {}).filter((g) => Number.isInteger(g) && g >= 0 && g < count).slice(0, n);
  const dummy = Array.from({ length: n }, (_, i) => String(i));
  const placement = Object.fromEntries(placed.map((g, i) => [String(i), g]));
  return dealGroups(dummy, count, { placement, challenger: groupPools(q).map((p) => p.challenger) }).map((g) => g.length);
}

/** The format with any hand placement of a team that is not among `ids` dropped. */
export function prunePlacement(format: TournamentFormat, ids: readonly string[]): TournamentFormat {
  const q = format.qualifier;
  if (q.format !== "groups" || !q.placement) return format;
  const keep = new Set(ids);
  const placement = Object.fromEntries(Object.entries(q.placement).filter(([id]) => keep.has(id)));
  return { ...format, qualifier: { ...q, placement } };
}

/**
 * Where the knockout line falls in each standings table - one per group, or the one Swiss table - or
 * undefined when nothing is cut (no knockout, or no qualifier to cut from).
 */
export function tableCuts(format: TournamentFormat): number[] | undefined {
  const q = format.qualifier;
  if (!format.knockout || q.format === "none") return undefined;
  if (q.format === "groups") return groupPools(q).map((p) => p.advance);
  return format.knockout.cutTo === undefined ? undefined : [format.knockout.cutTo];
}

/** How many entrants actually reach the knockout for a field of `n`. */
export function effectiveCut(format: TournamentFormat, n: number): number {
  if (!format.knockout) return 0;
  const q = format.qualifier;
  if (q.format === "none") return n;
  if (q.format === "groups") return groupPools(q).reduce((sum, p) => sum + p.advance, 0);
  return format.knockout.cutTo ?? 0;
}

const isBestOf = (x: number | undefined) => x === undefined || (Number.isInteger(x) && x >= 1 && x % 2 === 1);

/**
 * Everything wrong with `format` for a field of `n`, in words an organizer can act on. An empty list
 * means the format can be run. Checked against the field size rather than in isolation because most
 * of the interesting mistakes ("cut to 16" with 12 signed up) only exist in relation to it.
 */
export function validateFormat(format: TournamentFormat, n: number): string[] {
  const errors: string[] = [];
  const { qualifier, knockout } = format;

  if (n < 2) errors.push("An event needs at least two entrants.");
  if (qualifier.format === "none" && !knockout) errors.push("Choose a qualifier, a knockout, or both.");

  if (qualifier.format === "swiss") {
    if (!Number.isInteger(qualifier.rounds) || qualifier.rounds < 1) errors.push("Swiss needs at least one round.");
    else if (qualifier.rounds > n - 1) {
      errors.push(`Swiss with ${n} entrants can run ${Math.max(n - 1, 0)} rounds at most - after that everyone has met.`);
    }
    if (!isBestOf(qualifier.bestOf)) errors.push("Swiss series length must be an odd number.");
  }

  if (qualifier.format === "groups") {
    if (!Number.isInteger(qualifier.groupCount) || qualifier.groupCount < 1) errors.push("Choose at least one group.");
    else if (qualifier.groupCount > Math.floor(n / 2)) {
      errors.push(`${n} entrants can fill at most ${Math.floor(n / 2)} groups of two or more.`);
    } else {
      // Only once the count itself is sensible, or every group would repeat the same complaint. Hand
      // placement can leave a group short even when the count is fine - a challenger group nobody has
      // been put in yet, most often.
      groupSizes(qualifier, n).forEach((size, g) => {
        if (size < 2) errors.push(`${groupLabel([], g, "en")} has ${size === 0 ? "no teams" : "only one team"}; every group needs at least two.`);
      });
    }
    if (!isBestOf(qualifier.bestOf)) errors.push("Group series length must be an odd number.");
  }

  if (knockout) {
    const bo = [knockout.bestOf, knockout.semifinalBestOf, knockout.finalBestOf];
    if (bo.some((x) => !isBestOf(x)) || knockout.bestOf === undefined) {
      errors.push("Knockout series lengths must be odd numbers.");
    }
    if (knockout.format !== "single" && knockout.format !== "double") errors.push("Knockout must be single or double elimination.");

    if (qualifier.format === "swiss") {
      const cut = knockout.cutTo;
      if (cut === undefined || !Number.isInteger(cut) || cut < 2) errors.push("The cut must be at least 2 entrants.");
      else if (cut > n) errors.push(`Cannot cut to ${cut} with only ${n} entrants.`);
    }

    if (qualifier.format === "groups" && Number.isInteger(qualifier.groupCount) && qualifier.groupCount >= 1) {
      const pools = groupPools(qualifier);
      // Each group's own size is what limits it: a deal of 10 into 3 groups gives 4, 3 and 3.
      const sizes = groupSizes(qualifier, n);
      if (pools.some((p) => !Number.isInteger(p.advance) || p.advance < 1)) {
        errors.push("Choose how many teams advance from each group.");
      } else {
        pools.forEach((p, g) => {
          if (p.advance > sizes[g] && sizes[g] >= 2) {
            errors.push(`Taking ${p.advance} from ${groupLabel([], g, "en")} needs at least ${p.advance} teams in it; it has ${sizes[g]}.`);
          }
        });
        if (effectiveCut(format, n) < 2) errors.push("The knockout needs at least 2 entrants.");
      }
    }
  }
  return errors;
}

export interface GameEstimate {
  qualifier: number;
  /** Knockout matches, counting a series as one match. `max` includes a grand-final reset. */
  knockoutMin: number;
  knockoutMax: number;
}

/** Matches (series, not individual games) the event needs, for the setup page's "about N matches". */
export function estimateMatches(format: TournamentFormat, n: number): GameEstimate {
  let qualifier = 0;
  const q = format.qualifier;
  if (q.format === "swiss") {
    qualifier = q.rounds * Math.floor(n / 2);
  } else if (q.format === "groups") {
    qualifier = groupSizes(q, n).reduce((sum, s) => sum + ((s * (s - 1)) / 2) * q.legs, 0);
  }

  let knockoutMin = 0;
  let knockoutMax = 0;
  const k = format.knockout;
  if (k) {
    const c = effectiveCut(format, n);
    if (k.format === "single") {
      knockoutMin = knockoutMax = c - 1 + (k.thirdPlace && c >= 4 ? 1 : 0);
    } else {
      knockoutMin = 2 * c - 2;
      knockoutMax = knockoutMin + (k.grandFinalReset ? 1 : 0);
    }
  }
  return { qualifier, knockoutMin, knockoutMax };
}

/** Largest power of two that is <= x (x >= 1). */
const floorPow2 = (x: number) => 2 ** Math.floor(Math.log2(Math.max(x, 1)));

export interface Suggestion {
  format: TournamentFormat;
  /** Why this shape, one line each, for the setup page to show beside the controls. */
  reasons: string[];
}

/**
 * A sensible starting format for a field of `n`. It is a starting point, not a verdict: the setup
 * page fills the form with it and every field stays editable.
 *
 * The logic is about what a field of that size can bear:
 *   - a handful of entrants gets a double elimination, because a single loss ending a small event
 *     wastes most of the evening;
 *   - a mid-sized field gets Swiss into a knockout, which finds the best few without a giant group
 *     stage or a bracket where half the field goes home after one match;
 *   - and the qualifier grows by a round each time the field doubles, which is exactly enough to
 *     separate the top of it.
 */
export function suggestFormat(n: number): Suggestion {
  const single = (cutTo: number, semi: number, final: number): KnockoutConfig => ({
    format: "single",
    cutTo,
    bestOf: 1,
    semifinalBestOf: semi,
    finalBestOf: final,
    thirdPlace: false,
    grandFinalReset: false,
  });

  if (n < 2) {
    return {
      format: { qualifier: { format: "none" }, knockout: single(2, 1, 1) },
      reasons: ["Waiting for at least two entrants - this will update as people sign up."],
    };
  }
  if (n === 2) {
    return {
      format: { qualifier: { format: "none" }, knockout: single(2, 3, 5) },
      reasons: ["Two entrants: a single best-of-5 series."],
    };
  }
  if (n === 3) {
    return {
      format: { qualifier: { format: "groups", groupCount: 1, legs: 2, bestOf: 1 }, knockout: null },
      reasons: ["Three entrants: everyone plays everyone twice and the table decides it. A bracket would need a bye."],
    };
  }
  if (n <= 8) {
    return {
      format: {
        qualifier: { format: "none" },
        knockout: {
          format: "double",
          cutTo: n,
          bestOf: 1,
          semifinalBestOf: 3,
          finalBestOf: 3,
          thirdPlace: false,
          grandFinalReset: true,
        },
      },
      reasons: [
        `${n} entrants is small enough that a single loss shouldn't end anyone's event: double elimination.`,
        "Best-of-3 from the winners' and losers' finals on, and the grand final gets a reset.",
      ],
    };
  }

  const rounds = Math.min(recommendedSwissRounds(n), 8);
  const cut = n <= 11 ? 4 : n <= 24 ? 8 : n <= 48 ? 16 : 32;
  const finalists = Math.min(cut, floorPow2(n));
  return {
    format: {
      qualifier: { format: "swiss", rounds, bestOf: 1 },
      knockout: single(finalists, 3, 3),
    },
    reasons: [
      `${n} entrants: ${rounds} Swiss rounds is enough to separate the top of the field (log2 of the field, rounded up).`,
      `The top ${finalists} go through to a single-elimination bracket.`,
      "Best-of-3 for the semifinals and final; everything else is a single game.",
    ],
  };
}
