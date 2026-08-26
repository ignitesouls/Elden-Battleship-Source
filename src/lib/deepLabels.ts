import type { DeepMark } from "./deepWater";

/**
 * What to call each thing the water gave up.
 *
 * Its own module because two very different places name these and they must agree: the recap panel,
 * where the drawing beside the words is 2rem wide and the list is read at leisure, and the stream
 * alert, where the same words go up at 80px for a few seconds over somebody's gameplay. A viewer
 * who hears a caster say "the white whale" and then reads something else on the recap has been told
 * there were two events.
 *
 * Written for the moment of the find rather than as an index entry - "Laboon, who did not mind" is
 * the joke and the fact at once, and it is the same joke on a stream as in the record.
 */
export const DEEP_LABEL: Record<DeepMark, string> = {
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
 * What an ALERT calls a find, where the recap's name is the wrong one.
 *
 * Only the two second stages differ, and they differ for the same reason in both directions. On the
 * recap the square wears a tentacle and always did - "waking is what the last one did, not a
 * different thing to have found" - so listing it as anything else would claim two finds where there
 * was one. An alert is not a list: it fires at the moment it happens, and the moment IS the waking.
 * A stream alert that announced the biggest event in a match as "A tentacle" would be the caster
 * explaining what the overlay meant.
 */
const DEEP_ALERT_OVERRIDE: Partial<Record<DeepMark, string>> = {
  sleeper: "Cthulhu wakes",
  igonAvenged: "Igon, avenged",
};

/** What to put on a stream alert for this find. See DEEP_ALERT_OVERRIDE. */
export function alertLabel(mark: DeepMark): string {
  return DEEP_ALERT_OVERRIDE[mark] ?? DEEP_LABEL[mark];
}

/**
 * The two finds that are the biggest thing that can happen in a match.
 *
 * Cthulhu waking and Igon getting to his feet both land alongside ordinary finds - the shot that
 * wakes him is also the shot that found the fourth tentacle - so anything picking ONE find out of a
 * tick has to prefer these or they get silently dropped in favour of whichever square sorted first.
 * Shared so the sound and the picture can't disagree about which of two simultaneous finds was the
 * event. See useSpectatorSfx and pages/OverlayEgg.
 */
export function isHeadline(mark: DeepMark): boolean {
  return mark === "sleeper" || mark === "igonAvenged";
}
