/**
 * Checks that a square's name is sized to actually FIT its square.
 *
 * The thing this guards against is specific and was live on the board for a long time: a name whose
 * longest word is wider than one line gets that word broken by `overflow-wrap: anywhere`, the break
 * costs a line, and the line-clamp then ends the square in an ellipsis. Every "Dragonbarrow" square
 * did it, at every panel size, because the old fit was estimated from character counts.
 *
 * So this walks the real boss board at a spread of cell shapes and asserts the two things that have
 * to hold for a name to render whole: no word wider than a line, and enough lines for the name to
 * wrap into. It calls textFit's own line breaking rather than a second copy of it, so a bug there
 * can't be agreed with here.
 *
 * Bare Node has no canvas, so fitText measures with its flat-average fallback - this proves the
 * layout ARITHMETIC rather than the font metrics. The metrics are the browser's problem and the
 * browser is exact about them; the arithmetic is ours, and is what broke.
 *
 * Run with bare Node:
 *
 *   node --experimental-strip-types scripts/check-text-fit.ts
 */
import { readFileSync } from 'node:fs'
import {
  fitText,
  layoutAt,
  breakSegments,
  CELL_LINE_HEIGHT,
  CELL_PADDING_EM,
  SMALLEST,
} from '../src/lib/textFit.ts'
import { TEXT_SIZE_OPTIONS, OVERLAY_MAX_FONT } from '../src/lib/overlayText.ts'
import bosses from '../src/data/battleshipChallenges.json' with { type: 'json' }

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

/** Whether a name renders whole at the size fitText chose for it. */
function verdict(name: string, cellW: number, cellH: number, cap = 30, boost = 1) {
  const fit = fitText(name, cellW, cellH, cap, boost)
  const { lines } = layoutAt(name, fit.font, cellW)
  return {
    font: fit.font,
    lines: fit.lines,
    broken: lines === null,
    clipped: lines !== null && lines > fit.lines,
    detail: lines === null ? 'a word is wider than its line' : `${lines} lines, room for ${fit.lines}`,
  }
}

/**
 * Cell shapes to try. A 10x10 board in a panel dragged to the extremes of what the canvas allows,
 * plus the square cells the fixed layout produces. The wide-and-short and tall-and-narrow ones are
 * where a width-only rule and a height-only rule respectively stop being enough.
 *
 * `bossOnly` is the thumbnail: a board panel dragged down to about 400px across. A boss name fits
 * there and an objectives square genuinely does not - "Touch Precipice Overlook grace without
 * touching the other precipice grace" is fifty-odd characters, and no font size puts that in a 40px
 * box and leaves it readable. Those ellipsize, which is the correct answer and the reason the
 * ellipsis exists at all. Every shape anybody plays at is held to the full standard.
 */
const SHAPES: Array<[number, number, string, boolean?]> = [
  [40, 40, 'thumbnail', true],
  [60, 60, 'small square'],
  [88, 88, 'fixed layout at 1080p'],
  [140, 140, 'large square'],
  [160, 60, 'wide and short'],
  [220, 70, 'very wide and short'],
  [60, 160, 'narrow and tall'],
  [110, 45, 'dragged flat'],
]

/**
 * Every label any square set can print, which is not the same as every square's name: the bingo
 * sets ship a short form for their longer squares and the board draws that (see BoardGrid's
 * cellText). The objectives sets are where the longest labels live, so leaving them out would test
 * the fix on the easy half of the problem.
 */
/**
 * Fills `%variable%` placeholders with the LONGEST option the square offers.
 *
 * One entry in a set file becomes several squares: "Kill %graftedScionNum% Grafted Scions" is dealt
 * as "Kill 2", "Kill 3" or "Kill 4" - see makeResolver in squareSetFormat, which draws one per square
 * and reuses it. Measuring the raw string measures a seventeen-character token that never reaches a
 * board, which is both a false alarm and a missed one: wider than anything real, and hiding whichever
 * option genuinely is the widest. The longest option is the worst case a player can actually be
 * dealt, which is the case a fit check wants.
 */
function resolveLongest(text: string, square: Record<string, unknown>): string {
  return text.replace(/%(\w+)%/g, (whole, key: string) => {
    const options = square[key]
    if (!Array.isArray(options) || options.length === 0) return whole
    return options.map(String).reduce((longest, o) => (o.length > longest.length ? o : longest))
  })
}

function labels(): string[] {
  const read = (file: string) => JSON.parse(readFileSync(`src/data/${file}`, 'utf8'))
  const out = new Set<string>((bosses as Array<{ name: string }>).map((b) => b.name))

  const bingo: Array<[string, string | null]> = [
    ['incursionSquares.json', 'incursionShortNames.json'],
    ['rookieRumbleSquares.json', null],
    ['scaduLeagueSquares.json', null],
  ]
  for (const [squares, shorts] of bingo) {
    const short: Record<string, string> = shorts ? read(shorts) : {}
    // The short form carries the same placeholders as the name it abbreviates, so it is resolved
    // against the same square rather than trusted to be literal.
    for (const sq of read(squares).squares as Array<Record<string, unknown> & { name: string }>) {
      out.add(resolveLongest(short[sq.name] ?? sq.name, sq))
    }
  }
  for (const sq of read('ringusSquares.json') as Array<{ name: string }>) out.add(sq.name)

  return [...out]
}

const bossNames = (bosses as Array<{ name: string }>).map((b) => b.name)
const allNames = labels()
console.log(`${allNames.length} square labels across every set (${bossNames.length} of them bosses), ${SHAPES.length} cell shapes\n`)

/**
 * Whether a cell this wide could hold this name at ALL, even shrunk to the floor.
 *
 * A label whose longest unbreakable run is wider than the line at SMALLEST cannot be rendered whole
 * by anything this module does - "4 Wolf/Lion/Bear/Hippo Bosses" is one twenty-character token (see
 * tokenize on why the slash is not a break) and a 60px line has no size that holds it. The browser's
 * `overflow-wrap: anywhere` backstop takes those, which is the documented and correct fallback.
 *
 * Counted and reported rather than asserted on, so the assertion keeps its meaning for every label
 * that CAN fit. Silently including them is what a green check hiding a real failure looks like.
 */
const impossible = (name: string, cellW: number) => layoutAt(name, SMALLEST, cellW).lines === null

for (const [w, h, shape, bossOnly] of SHAPES) {
  const names = (bossOnly ? bossNames : allNames).filter((n) => !impossible(n, w))
  const unfittable = (bossOnly ? bossNames : allNames).length - names.length
  const broken: string[] = []
  const clipped: string[] = []
  let smallest = Infinity

  for (const name of names) {
    const v = verdict(name, w, h)
    smallest = Math.min(smallest, v.font)
    if (v.broken) broken.push(`${name} (${v.detail})`)
    else if (v.clipped) clipped.push(`${name} (${v.detail})`)
  }
  if (unfittable > 0) console.log(`         ${unfittable} label(s) too long for a ${w}px line at any size - the anywhere-backstop takes those`)

  check(`${shape} (${w}x${h}) - no name has a word too wide for its line`, broken.length === 0, broken.slice(0, 3).join('; '))
  check(`${shape} (${w}x${h}) - no name needs more lines than it gets`, clipped.length === 0, clipped.slice(0, 3).join('; '))
  console.log(`         smallest font on this shape: ${smallest.toFixed(1)}px`)
}

console.log('')

/**
 * A short name must not be shrunk for the sake of a long one. This is the whole reason the fit is
 * per-square rather than per-board: "Rick" at the size the longest name on the board needs would be
 * unreadable on a stream.
 */
const short = fitText('Rick', 88, 88, 30)
check("a short name keeps the square's natural size", Math.abs(short.font - 88 / 7.2) < 0.01, `${short.font.toFixed(1)}px`)

/** And a name that fits at that size is not shrunk either, however many words it has. */
const roomy = verdict('Black Knife Near Sainted HG', 88, 88)
check('a long name that fits is left alone', roomy.font === short.font && !roomy.broken && !roomy.clipped, `${roomy.font.toFixed(1)}px`)

/** But one that doesn't fit comes down until it does, rather than being clipped. */
const tight = verdict('Black Knife Near Sainted HG', 96, 34)
check('a long name in a tight cell is shrunk instead', tight.font < 96 / 7.2 && !tight.broken && !tight.clipped, `${tight.font.toFixed(1)}px`)

/**
 * The regression itself, named. Twelve characters was one over the old estimate's eleven-character
 * word limit, so "Dragonbarrow" shrank by 8% and still overflowed - at every size.
 */
for (const [w, h] of SHAPES) {
  const v = verdict('Dragonbarrow Night Cav', w, h)
  check(`"Dragonbarrow" stays in one piece at ${w}x${h}`, !v.broken && !v.clipped, v.broken || v.clipped ? v.detail : '')
}

/**
 * The line budget has to describe the cell it was computed for, or the clamp cuts a line short.
 *
 * PADDING INCLUDED. Leaving it out is what let this pass for months while a name that came out at
 * exactly N lines rendered 0.1em taller than its own box - the assertion agreed with the bug because
 * it was doing the same arithmetic the bug was. Caught by measuring scrollHeight against
 * clientHeight in a real browser, which is a thing bare Node cannot do; this is that finding written
 * down somewhere it runs on every commit.
 */
for (const [w, h] of SHAPES) {
  const fit = fitText('Dragonbarrow Night Cav', w, h, 30)
  const used = fit.lines * fit.font * CELL_LINE_HEIGHT + fit.font * CELL_PADDING_EM
  check(
    `the line budget fits inside the ${w}x${h} cell, padding included`,
    used <= h + 0.01,
    `${fit.lines} lines x ${fit.font.toFixed(1)}px = ${used.toFixed(1)} of ${h}px`
  )
}


/**
 * -- The stream sources, at every text size a streamer can pick ----------------------------------
 *
 * The size control raises the ceiling the fit searches DOWN from (see lib/overlayText). The claim
 * that makes it safe to hand to somebody mid-broadcast is that it cannot break a name: a square with
 * no room for the size asked spends it back on the way down and renders whole at whatever does fit.
 * That claim is exactly the two assertions above, so they are re-run at every offered size rather
 * than trusted.
 *
 * Cell shapes are the ones a browser source actually produces, which are far larger than anything in
 * the app: a 1000x1000 source is about 93px a cell on a 10x10 board and twice that at 2x zoom, where
 * the old 17px ceiling was binding and the names had stopped growing with their squares.
 */
console.log('')

/**
 * `bossOnly` marks a cell too small to hold a long objectives label at all, exactly as the 40x40
 * thumbnail above is - a 20x20 board on a 1000px source is a 46px square, and "Touch Precipice
 * Overlook grace without touching the other precipice grace" does not go in one at any font size.
 * Those ellipsize, which is the established answer here and is not something the size control
 * changes either way: it clips identically at Small and at Colossal. The no-worse-than-Normal check
 * below holds every label on every shape to the standard that IS this feature's to keep.
 */
const OVERLAY_SHAPES: Array<[number, number, string, boolean?]> = [
  [93, 93, '1000px source, 10x10'],
  [186, 186, '1000px source, 10x10 at 2x zoom'],
  [46, 46, '1000px source, 20x20', true],
  [140, 140, '1500px source, 10x10'],
]

for (const [w, h, shape, bossOnly] of OVERLAY_SHAPES) {
  const names = bossOnly ? bossNames : allNames
  const broken: string[] = []
  const clipped: string[] = []
  /** Per size: the range every label lands in, which is the legibility figure that matters. */
  const floors: string[] = []

  for (const { value, label } of TEXT_SIZE_OPTIONS) {
    let smallest = Infinity
    let largest = 0
    for (const name of names) {
      const v = verdict(name, w, h, OVERLAY_MAX_FONT, value)
      smallest = Math.min(smallest, v.font)
      largest = Math.max(largest, v.font)
      if (v.broken) broken.push(`${name} at ${label} (${v.detail})`)
      else if (v.clipped) clipped.push(`${name} at ${label} (${v.detail})`)
    }
    floors.push(`${label} ${smallest.toFixed(1)}-${largest.toFixed(1)}px`)
  }

  check(`${shape} - no name breaks at any offered text size`, broken.length === 0, broken.slice(0, 3).join('; '))
  check(`${shape} - no name is clipped at any offered text size`, clipped.length === 0, clipped.slice(0, 3).join('; '))
  console.log(`         ${floors.join(' · ')}`)
}

/**
 * The guarantee that is actually this feature's to keep: changing the size never makes a label
 * render WORSE than it does at Normal.
 *
 * Held to every label on every shape, including the ones a 46px square was always going to
 * ellipsize - the question there isn't whether it fits, it's whether the size control made it stop
 * fitting. That is the failure a streamer would blame on the new control, and the one thing the
 * "it can only ever draw smaller than you asked" argument has to actually deliver.
 */
{
  const worse: string[] = []
  for (const [w, h, shape] of OVERLAY_SHAPES) {
    for (const name of allNames) {
      const base = verdict(name, w, h, OVERLAY_MAX_FONT, 1)
      for (const { value, label } of TEXT_SIZE_OPTIONS) {
        const v = verdict(name, w, h, OVERLAY_MAX_FONT, value)
        if (v.broken && !base.broken) worse.push(`${name} on ${shape} breaks at ${label}`)
        else if (v.clipped && !base.clipped) worse.push(`${name} on ${shape} clips at ${label}`)
      }
    }
  }
  check('no text size renders a label worse than Normal does', worse.length === 0, worse.slice(0, 3).join('; '))
}

/**
 * Every label, every overlay shape, every offered size: the lines it was given plus the padding
 * under them must fit the cell. This is the assertion that would have caught the 0.1em overrun.
 */
{
  const over: string[] = []
  for (const [w, h, shape] of OVERLAY_SHAPES) {
    for (const name of allNames) {
      for (const { value, label } of TEXT_SIZE_OPTIONS) {
        const fit = fitText(name, w, h, OVERLAY_MAX_FONT, value)
        const used = fit.lines * fit.font * CELL_LINE_HEIGHT + fit.font * CELL_PADDING_EM
        if (used > h + 0.01) over.push(`${name} on ${shape} at ${label}: ${used.toFixed(1)} of ${h}px`)
      }
    }
  }
  check('no label overruns its cell at any offered text size', over.length === 0, over.slice(0, 3).join('; '))
}

console.log('')

/**
 * Asking for larger text never makes a name smaller.
 *
 * The one way this feature could be actively confusing rather than merely ineffective: a streamer
 * clicks the next size up and a square goes DOWN, because the fit found a different local answer.
 * It can't, since the boost only raises the search's upper bound and the fitting set is contiguous -
 * but that is an argument, and this is the whole board checked against it.
 */
{
  const regressions: string[] = []
  for (const [w, h, shape] of OVERLAY_SHAPES) {
    for (const name of allNames) {
      let previous = 0
      for (const { value, label } of TEXT_SIZE_OPTIONS) {
        const { font } = fitText(name, w, h, OVERLAY_MAX_FONT, value)
        if (font < previous - 0.01) regressions.push(`${name} on ${shape} shrank at ${label}`)
        previous = font
      }
    }
  }
  check('a larger text size never shrinks a name', regressions.length === 0, regressions.slice(0, 3).join('; '))
}

/**
 * "Normal" is the size the board has always drawn at.
 *
 * The default has to be a no-op or every source already pointed at a room changes the moment this
 * ships, which is not a thing to do to somebody's scene without them asking.
 */
{
  const drifted: string[] = []
  for (const [w, h, shape] of OVERLAY_SHAPES) {
    for (const name of allNames) {
      // Cap held at the app's 17 on the left-hand side, since that is what this board rendered with
      // before - so this compares the whole change, ceiling included, not just the boost.
      const before = fitText(name, w, h, 17).font
      const after = fitText(name, w, h, OVERLAY_MAX_FONT, 1).font
      // Only the cells where 17px was NOT the binding constraint should be unchanged; where it was,
      // the name is expected to grow, which is the fix.
      if (before < 16.99 && Math.abs(before - after) > 0.01) drifted.push(`${name} on ${shape}: ${before.toFixed(1)} -> ${after.toFixed(1)}`)
    }
  }
  check('"Normal" leaves every name the board was already fitting untouched', drifted.length === 0, drifted.slice(0, 3).join('; '))
}

/**
 * The <wbr> segments must rebuild the name exactly.
 *
 * BoardGrid renders these segments in place of the label itself, so anything this dropped, doubled
 * or reordered would be a name silently rendering wrong on every board - and a split that loses a
 * character is exactly the kind of thing a regex edit does quietly. Cheap to assert, and it covers
 * the one place the measurement and the markup are joined.
 */
{
  const mangled = allNames.filter((name) => breakSegments(name).join('') !== name)
  check('the rendered break segments rebuild every label exactly', mangled.length === 0, mangled.slice(0, 3).join('; '))

  // And the split has to actually do something, or the <wbr> path is dead code and the slash
  // measurement below is passing for the wrong reason.
  const split = allNames.filter((name) => breakSegments(name).length > 1).length
  check('slashed labels are split for the renderer', split > 0, `${split} labels carry a break opportunity`)
}

/**
 * Grow-to-fit: the stream sources let a name use its whole square.
 *
 * The default fit stops at the board's natural ratio, which is right at app sizes and wrong on a
 * browser source - a 1000px board at 10x10 gave "Dane" about 13px in a 92px square, and the shorter
 * the name the emptier the square. `grow` lifts that ceiling so the search finds the largest size
 * that actually FITS.
 *
 * Three properties matter and none is obvious from reading the bisection:
 *
 *   - it must never make a name smaller than the old path (it only raises a ceiling),
 *   - it must genuinely vary with the name, which is the whole request - a board where everything
 *     grew by the same factor would look identical to a board that had simply been zoomed,
 *   - and it must still never overflow, or the ellipsis this module exists to prevent comes back.
 */
{
  // A browser-source cell: 1000px across a 10x10 board, less the coordinate gutters.
  const W = 92
  const H = 92
  const short = 'Dane'
  const long = 'Consecrated Death Rite Bird'

  const shortOld = fitText(short, W, H, OVERLAY_MAX_FONT, 1, false).font
  const shortNew = fitText(short, W, H, OVERLAY_MAX_FONT, 1, true).font
  const longNew = fitText(long, W, H, OVERLAY_MAX_FONT, 1, true).font

  check('a short name grows when allowed to fill', shortNew > shortOld * 2, `${shortOld.toFixed(1)} -> ${shortNew.toFixed(1)}`)
  check('a long name stays small', longNew < shortNew / 2, `long ${longNew.toFixed(1)} vs short ${shortNew.toFixed(1)}`)

  // Nothing may shrink. Asserted across the whole board, because a ceiling that was lifted for one
  // name and lowered for another would be a regression hiding behind an improvement.
  const shrank = allNames.filter((name) => {
    const a = fitText(name, W, H, OVERLAY_MAX_FONT, 1, false).font
    const b = fitText(name, W, H, OVERLAY_MAX_FONT, 1, true).font
    return b < a - 0.01
  })
  check('grow-to-fit never shrinks a name', shrank.length === 0, shrank.slice(0, 3).join('; '))

  // And it still has to fit. `layoutAt` runs the same greedy line breaking the browser will.
  const overflowed = allNames.filter((name) => {
    const { font, lines } = fitText(name, W, H, OVERLAY_MAX_FONT, 1, true)
    const needed = layoutAt(name, font, W).lines
    return needed === null || needed > lines
  })
  check('grow-to-fit never overflows its cell', overflowed.length === 0, overflowed.slice(0, 3).join('; '))

  // The size really does depend on the name rather than being one number for the board.
  const distinct = new Set(allNames.map((n) => Math.round(fitText(n, W, H, OVERLAY_MAX_FONT, 1, true).font)))
  check('size varies with the name', distinct.size > 5, `${distinct.size} distinct sizes across ${allNames.length} labels`)

  // The caster's slider only trims. Above 1 there is nothing left to give.
  const trimmed = fitText(short, W, H, OVERLAY_MAX_FONT, 0.5, true).font
  const overdriven = fitText(short, W, H, OVERLAY_MAX_FONT, 2, true).font
  check('the slider trims below 1', Math.abs(trimmed - shortNew * 0.5) < 0.01, `${trimmed.toFixed(1)}`)
  check('asking above 1 is capped at what fits', Math.abs(overdriven - shortNew) < 0.01, `${overdriven.toFixed(1)}`)
}

console.log(failures === 0 ? '\nall text fit checks passed' : `\n${failures} text fit check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
