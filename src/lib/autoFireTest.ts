/**
 * The auto-marking test: a fake two-square game that proves the game mod reaches the website.
 *
 * Shared by the OBS & auto-marking page (components/AutoFireTest) and the auto-fire edge function,
 * which answers the mod from it - so the board, the countdown and the window are defined once. Kept
 * free of imports for that reason: the edge function runs under Deno and can't pull in the browser's
 * square-set registry.
 *
 * -- Why these two squares, always in this order -------------------------------------------------
 *
 * Both are early Limgrave bosses a training tool can warp to and one-shot on a fresh save, and both
 * are single bosses, so one kill sets one flag. No randomization: a test that deals differently each
 * time is one more thing to explain when it fails. Cell 0 is BOFA, cell 1 the Tree Sentinel.
 */

export const AUTOFIRE_TEST_SQUARES = [
  { name: "BOFA", tooltip: "Beastman of Farum Azula - Groveside Cave" },
  { name: "LG Tree Sent", tooltip: "Tree Sentinel - Church of Elleh" },
] as const;

/** The countdown before the test goes live. Kills seen during it were already dead on the save. */
export const AUTOFIRE_TEST_PREP_SECONDS = 10;

/** How long a test is honoured after it starts. A row older than this is ignored, not swept. */
export const AUTOFIRE_TEST_MINUTES = 10;

export type AutoFireTestPhase = "preparation" | "match" | "over";

/** Where a test started at `startedMs` stands at `nowMs`, and the seconds to show for it. */
export function autoFireTestPhaseAt(startedMs: number, nowMs: number): { phase: AutoFireTestPhase; seconds: number } {
  const elapsed = (nowMs - startedMs) / 1000;
  if (elapsed >= AUTOFIRE_TEST_MINUTES * 60) return { phase: "over", seconds: 0 };
  if (elapsed < AUTOFIRE_TEST_PREP_SECONDS) {
    return { phase: "preparation", seconds: Math.max(0, Math.ceil(AUTOFIRE_TEST_PREP_SECONDS - elapsed)) };
  }
  return { phase: "match", seconds: Math.floor(elapsed - AUTOFIRE_TEST_PREP_SECONDS) };
}

/** One test kill as the edge function records it. */
export interface AutoFireTestKill {
  at: string;
  phase: "preparation" | "match";
}
