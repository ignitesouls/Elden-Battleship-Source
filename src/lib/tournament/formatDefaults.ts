import type { KnockoutConfig, QualifierConfig } from "./format";
import { recommendedSwissRounds } from "./swiss";

/**
 * Starting points for the format editor when an administrator switches the kind of qualifier.
 *
 * Changing "Swiss" to "Groups" should not leave the form holding a Swiss round count and no group
 * count, or drop them into a state the format validator rejects. So each kind comes with defaults
 * chosen to be valid for the field size at hand - the administrator then adjusts from a format that
 * already works, rather than assembling one from nothing.
 */
export type QualifierKind = QualifierConfig["format"];

const floorPow2 = (x: number) => 2 ** Math.floor(Math.log2(Math.max(x, 1)));

export function defaultQualifier(kind: QualifierKind, n: number): QualifierConfig {
  if (kind === "swiss") return { format: "swiss", rounds: recommendedSwissRounds(n), bestOf: 1 };
  if (kind === "groups") {
    // About four to a group, up to four groups. The smallest group is what limits how many can advance.
    const groupCount = Math.min(4, Math.max(1, Math.floor(n / 4)));
    const smallest = Math.floor(n / groupCount);
    return {
      format: "groups",
      groupCount,
      advancePerGroup: groupCount === 1 ? Math.min(4, smallest) : Math.min(2, smallest),
      legs: 1,
      bestOf: 1,
    };
  }
  return { format: "none" };
}

/** A knockout to follow a qualifier of the given kind. `cutTo` only matters after a Swiss qualifier. */
export function defaultKnockout(n: number): KnockoutConfig {
  return {
    format: "single",
    cutTo: Math.max(2, Math.min(8, floorPow2(n))),
    bestOf: 1,
    semifinalBestOf: 3,
    finalBestOf: 3,
    thirdPlace: false,
    grandFinalReset: false,
  };
}
