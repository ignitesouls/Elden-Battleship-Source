import { useSyncExternalStore } from "react";

/**
 * How large a square's name can be drawn, and how many lines it gets.
 *
 * This used to be estimated from the name's LENGTH - a character count against a baseline, plus a
 * second rule capping the longest single word at eleven characters, both tuned by eye against the
 * board face. It worked for most names and was wrong at the boundary in the way estimates always
 * are: "Dragonbarrow" is twelve characters, so it was shrunk by 8% and still didn't fit, at which
 * point `overflow-wrap: anywhere` split it across two lines, the split cost the name a line, and the
 * line-clamp ended the square in an ellipsis. Every Dragonbarrow square on the board did this, at
 * every panel size, because an estimate that is wrong is wrong at all scales.
 *
 * So the fit is computed rather than guessed, in two parts:
 *
 *   - Canvas 2D gives the exact advance width of a word in a given font, which turns "is this word
 *     wider than a line" from a heuristic into arithmetic - and it keeps working when somebody
 *     renames a square, which the tuned constants did not.
 *   - The name is then laid out the way the browser will lay it out, greedily, at a candidate size,
 *     and the size is searched for rather than solved for. An earlier pass here DID solve it - fit
 *     the name's total width into the cell's area and take the square root - and it was wrong in the
 *     same direction for the same reason: wrapping wastes whatever is left at the end of each line,
 *     and how much that is depends on where the words happen to break. On a two-line cell that waste
 *     is most of a line. Laying it out is the only thing that knows.
 */

/** Line-height the cell text is laid out at. Must match .bg-cell-text, which this divides by. */
export const CELL_LINE_HEIGHT = 1.25;

/**
 * Bottom padding on the name, in ems. Must match `padding-bottom` on .bg-cell-text.
 *
 * It is there to keep the last line's descenders off the clip edge, and it used to be missing from
 * the arithmetic below - which quietly spent it twice. The lines were budgeted against the cell's
 * FULL height, so a name that came out at exactly N lines filled the box, and then this padding put
 * it 0.1em over the top of its own container. `overflow: hidden` and the line clamp then took the
 * difference out of the very descenders the padding exists to protect.
 *
 * Invisible for a long time because it only bites when a name saturates its cell exactly. Larger
 * text saturates far more often, so raising the ceiling for stream sources (see lib/overlayText) is
 * what turned a rare cosmetic clip into 28 squares of a 100-square objectives board losing their
 * last line. Measured in a real browser, not derived - see the note about metrics at the top.
 */
export const CELL_PADDING_EM = 0.1;

/**
 * How many whole lines of `font` fit in a cell this tall, padding included.
 *
 * The one place that answer is computed, because the fit test and the returned line budget have to
 * agree exactly: a clamp allowed one more line than `fitsAt` checked for is precisely the ellipsis
 * this is here to prevent.
 */
export function linesInHeight(font: number, cellH: number): number {
  return Math.floor((cellH - font * CELL_PADDING_EM) / (font * CELL_LINE_HEIGHT));
}

/**
 * Font size the measurements are taken at.
 *
 * Text advance scales linearly with font size, so one measurement per name answers every size the
 * panel can be dragged to. Large enough that hinting and sub-pixel rounding are a rounding error.
 */
const REFERENCE_PX = 100;

/**
 * Cell width over font size for a name that needs no shrinking at all.
 *
 * The size the board has always drawn short names at, kept exactly so that "Rick" and "Margit" look
 * the way they did. The search below only ever comes DOWN from here; the one way past it is a
 * caller passing a `boost` above 1, which is a stream source being told to draw for a viewer sitting
 * further away than the person at the keyboard. See lib/overlayText.
 */
const NATURAL = 7.2;

/**
 * The smallest a name may be shrunk before an ellipsis takes over.
 *
 * Five, not the seven it was. Seven was chosen as the smallest size a name is worth reading at,
 * which is the wrong question: the alternative to shrinking further is not a bigger name, it is a
 * name broken through the middle of a word by `overflow-wrap`, and that reads as a rendering fault
 * rather than as a long name. On a stream nobody can hover the square to find out what it said.
 *
 * Five is what the longest word on the boss board ("Dragonbarrow") needs in the smallest cell the
 * canvas can be dragged to - a 10x10 board in a panel around 400px across, where the whole grid is
 * a thumbnail and nobody is reading squares off it anyway. Every size anyone plays at lands well
 * above this; it is a floor, not a target. See scripts/check-text-fit.ts.
 */
export const SMALLEST = 5;

/**
 * How much of a line the text is allowed to claim.
 *
 * A word sized to exactly the width of its line has no margin for the half-pixel the browser rounds
 * it to, and half a pixel is the difference between one line and two. 2% is enough to absorb that
 * without visibly costing anything.
 */
const SAFETY = 0.98;

/** One chunk of a name that a line break cannot fall inside. */
interface Token {
  /** Width in ems - i.e. at font-size 1, so it scales to any size by multiplication. */
  w: number;
  /** Whether a space sits between this and the token before it. */
  space: boolean;
}

interface Widths {
  tokens: Token[];
  /** One space, in the same units. */
  space: number;
}

/**
 * A name split at the points where the board puts an explicit break opportunity.
 *
 * -- Why this exists, and why it is exported -----------------------------------------------------
 *
 * Browsers do not break after a slash. Measured in headless Chrome, which is what every OBS browser
 * source and most players are running:
 *
 *     "Wolf/Lion"           in a 62px box -> ONE 73px line, overflowing
 *     "Tunnels/Precipices," in a 120px box -> ONE 149px line, overflowing
 *     "Black-Knife"         in a 62px box -> two lines, "Black-" then "Knife"  (hyphens DO break)
 *
 * This module used to assume the opposite, on the reasoning that a slashed run like "4
 * Wolf/Lion/Bear/Hippo Bosses" is not really one twenty-character word and the browser "was always
 * going to" break it. It wasn't. So names were sized for a break that never came and the
 * `overflow-wrap: anywhere` backstop chopped them mid-word instead - "Precip ices", "Bea r/Hippo" -
 * which reads as a rendering fault rather than as a long name.
 *
 * Treating the run as unbreakable is honest but expensive: the square shrinks to fit a whole run
 * nobody needs on one line. So the board MAKES the break rather than assuming it. BoardGrid renders
 * these segments joined with <wbr>, which offers a line-break opportunity and contributes nothing to
 * the text - the label's string, its aria-label, its tooltip and anything copied off the board are
 * all byte-identical. (A zero-width space breaks identically but is a real character and lands in
 * all four; a soft hyphen draws a visible hyphen. Both measured, both rejected.)
 *
 * Exported because the measurement and the markup have to agree, and them disagreeing IS the bug
 * above. Both sides call this, so the assumption and the thing that makes it true cannot drift.
 */
export function breakSegments(label: string): string[] {
  return label.split(/(?<=\/)/).filter(Boolean);
}

/**
 * Splits a name into the runs a line break cannot fall inside.
 *
 * Spaces, obviously; after a hyphen, which browsers break at unaided; and after a slash, which they
 * do not - that one is a break only because breakSegments above is also what gets rendered.
 */
function tokenize(label: string, em: (s: string) => number): Token[] {
  const tokens: Token[] = [];
  label
    .split(/\s+/)
    .filter(Boolean)
    .forEach((word, i) => {
      breakSegments(word).forEach((segment, j) => {
        segment
          .split(/(?<=-)/)
          .filter(Boolean)
          .forEach((piece, k) => tokens.push({ w: em(piece), space: i > 0 && j === 0 && k === 0 }));
      });
    });
  return tokens;
}

const widths = new Map<string, Widths>();

/** undefined = not tried yet, null = no canvas here. */
let measurer: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (measurer !== undefined) return measurer;
  measurer = null;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      // The board face, read from the stylesheet rather than written down again here - the two
      // drifting apart would mean measuring one font and drawing another, which is worse than the
      // estimate this replaces.
      const family = getComputedStyle(document.documentElement).getPropertyValue("--font-board").trim();
      ctx.font = `700 ${REFERENCE_PX}px ${family || "sans-serif"}`;
      measurer = ctx;
    }
  } catch {
    // No canvas (bare Node, a locked-down embed). Falls back to the flat average below, which is
    // roughly the old estimate's accuracy - so a board still draws, just less precisely.
  }
  return measurer;
}

/**
 * Average advance per character in the board face, for when there is no canvas to ask.
 *
 * scripts/check-text-fit.ts runs the whole board through this path, since bare Node has no canvas -
 * so it proves the layout ARITHMETIC rather than the font metrics. The metrics are the browser's
 * problem and the browser is exact about them; the arithmetic is ours, and is what broke.
 */
const FALLBACK_EM = 0.62;

function measure(label: string): Widths {
  const hit = widths.get(label);
  if (hit) return hit;

  const ctx = context();
  const em = (s: string) => (ctx ? ctx.measureText(s).width / REFERENCE_PX : s.length * FALLBACK_EM);
  const out: Widths = { tokens: tokenize(label, em), space: em(" ") };
  widths.set(label, out);
  return out;
}

/**
 * Greedy line breaking, which is what CSS does.
 *
 * Returns how many lines the name takes at this line width, or null if a single word is wider than
 * the line - the case that has to be a hard no rather than an extra line, because the browser's
 * answer to it is to break the word in half.
 *
 * @param perLine usable line width, in ems at the candidate font size.
 */
function linesNeeded(w: Widths, perLine: number): number | null {
  let lines = 1;
  let used = 0;
  for (const token of w.tokens) {
    if (token.w > perLine) return null;
    const withToken = used === 0 ? token.w : used + (token.space ? w.space : 0) + token.w;
    if (withToken > perLine) {
      lines++;
      used = token.w;
    } else {
      used = withToken;
    }
  }
  return lines;
}

/** Whether the whole name lands inside the cell at this size. */
function fitsAt(w: Widths, font: number, cellW: number, cellH: number): boolean {
  const lines = linesInHeight(font, cellH);
  if (lines < 1) return false;
  const needed = linesNeeded(w, (cellW / font) * SAFETY);
  return needed !== null && needed <= lines;
}

/**
 * Everything measured before the board face finished loading was measured against a fallback font,
 * and is wrong by however much the two differ. Jost is a wide face and the system fallback usually
 * isn't, so this is not a small error - it is the difference between a name fitting and not.
 *
 * Both caches are therefore thrown away when the real font arrives, and every board re-renders.
 */
let version = 0;
const listeners = new Set<() => void>();

function refit() {
  widths.clear();
  fits.clear();
  // The context goes too. Chromium resolves the family behind `ctx.font` when the property is SET,
  // so a context built while Jost was still downloading keeps measuring the fallback no matter how
  // many times its cache is emptied - and a stale measurer is exactly the bug this is here to fix.
  measurer = undefined;
  version++;
  for (const notify of listeners) notify();
}

if (typeof document !== "undefined" && document.fonts) {
  /**
   * `loadingdone`, not just `ready`. This used to hang on `ready` alone, which fires ONCE and by
   * then is usually already too late:
   *
   *   - `--font-board` is used by nothing except a board square, and the fonts are `font-display:
   *     swap`, so Jost doesn't begin downloading until the first board paints.
   *   - A board only paints once the room has come back from Supabase, which on every overlay
   *     source is well after the document's `load` event.
   *
   * So `document.fonts.ready` resolved on an empty queue while the page was still waiting on the
   * network, the invalidation was spent on caches that were also empty, and every name measured
   * after that - i.e. all of them - kept its fallback-font width forever. On stream, where names
   * are drawn several times larger than in the app, "Misbegotten" then missed its line by about a
   * character and `overflow-wrap: anywhere` broke it as "Misbegotte / n".
   *
   * `loadingdone` fires per batch of faces, so it catches a download that starts at any point in
   * the page's life. Harmless to fire more than once: re-rendering a board loads no new fonts, so
   * there is nothing here to feed itself.
   */
  document.fonts.addEventListener("loadingdone", refit);
  void document.fonts.ready.then(refit);
}

/**
 * Subscribes a component to that one invalidation. Returns a counter that changes exactly once.
 *
 * Nothing reads the value - re-rendering IS the effect, because the fit is computed during render.
 */
export function useTextFit(): number {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    () => version,
    () => version
  );
}

export interface TextFit {
  /** Font size in px. */
  font: number;
  /** How many lines the cell has room for at that size, for the line clamp. */
  lines: number;
}

/**
 * Answers per (name, cell shape), because every square on a board shares the shape.
 *
 * A hundred squares asking about a hundred different names at ONE size is a hundred misses and then
 * nothing, which is the shape of a render; a drag re-asks at a new size every frame. Bounded by
 * simply emptying it, since the entries a new size wants are all misses anyway and an LRU would be
 * bookkeeping for no gain.
 */
const fits = new Map<string, TextFit>();
const FIT_CACHE_MAX = 4000;

/**
 * The largest this name can be drawn in a cell of this size without being cut off.
 *
 * Bisected between SMALLEST and the natural size, because `fitsAt` is monotonic - shrinking the text
 * both fits more on a line and buys more lines, so it can never stop fitting on the way down. Twenty
 * halvings settle it well past the precision a font size is rounded to anyway.
 *
 * @param largest cap on the result - the two layouts allow different maximums, see BoardGrid.
 * @param boost how far above the board's natural size this name may be drawn, as a multiplier.
 *   Raises only the STARTING point of the search: the name still has to pass `fitsAt`, so a boost
 *   the square has no room for is spent back on the way down and the name lands wherever it does
 *   fit. That is what makes it safe to hand a streamer - the worst a large one can do is nothing.
 */
export function fitText(label: string, cellW: number, cellH: number, largest: number, boost = 1): TextFit {
  const key = `${label}|${Math.round(cellW)}|${Math.round(cellH)}|${largest}|${boost}`;
  const hit = fits.get(key);
  if (hit) return hit;

  const w = measure(label);
  const upper = Math.max(SMALLEST, Math.min(largest, (cellW / NATURAL) * boost));

  let font: number;
  if (fitsAt(w, upper, cellW, cellH)) {
    // The common case by far: a short name in a square big enough for it, drawn at the size the
    // board has always drawn it. No search, and nothing changes for the squares that were fine.
    font = upper;
  } else if (!fitsAt(w, SMALLEST, cellW, cellH)) {
    // A cell too small to hold this name however far it shrinks. The clamp ends it in an ellipsis,
    // which is the honest answer - and is why SMALLEST is a readability floor rather than a fit.
    font = SMALLEST;
  } else {
    let lo = SMALLEST;
    let hi = upper;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (fitsAt(w, mid, cellW, cellH)) lo = mid;
      else hi = mid;
    }
    font = lo;
  }

  const out: TextFit = { font, lines: Math.max(1, linesInHeight(font, cellH)) };
  if (fits.size >= FIT_CACHE_MAX) fits.clear();
  fits.set(key, out);
  return out;
}

/**
 * The layout `fitText` settled on, for scripts/check-text-fit.ts to assert against.
 *
 * Exported so the check exercises the real line breaking rather than a second copy of it that could
 * agree with a bug. Nothing in the UI needs it.
 */
export function layoutAt(label: string, font: number, cellW: number): { lines: number | null } {
  return { lines: linesNeeded(measure(label), (cellW / font) * SAFETY) };
}
