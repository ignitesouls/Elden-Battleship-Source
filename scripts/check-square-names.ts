/**
 * Checks that RENAMED_SQUARES still describes a rename anyone could act on.
 *
 *   node --experimental-strip-types scripts/check-square-names.ts
 *
 * A square's name IS its identity in `match_events`, so renaming one splits its history unless the
 * old name is folded into the new (see RENAMED_SQUARES). The failure mode is silence: nothing throws,
 * the Almanac just shows one boss twice with half its attempts each, and board balancing measures
 * reachability off matches it can no longer reconcile.
 *
 * This is the half of the guard that needs no database. It cannot know a rename happened - only
 * scripts/audit-square-names.mjs can, by reading what the archive actually holds - but it does catch
 * every way an entry that IS written down can be wrong, which is the common case, since an entry is
 * typed by hand at the moment of the rename and never looked at again.
 *
 * Add it to `npm run check` and a broken map fails on the machine that broke it.
 */
import { readFileSync } from 'node:fs'
import { RENAMED_SQUARES, canonicalSquareName } from '../src/lib/squareSetFormat.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

interface RawSquare {
  name: string
  [key: string]: unknown
}

/**
 * Every name a set can put on a square, with its `%var%` placeholders expanded - one entry per
 * SQUARE, deduplicated within it.
 *
 * The bingo sets author one square as "Kill %demiNum% Unique Demi-Human Bosses" and put "Kill 4 ..."
 * on the board, so the raw name is not what a rename would ever be written against.
 *
 * The dedupe is what makes the duplicate check below mean anything. Scadu League weights a variable
 * by repeating its values - `"hang": ["2","3","3","3"]` is one square that lands on "3" three times
 * as often - so a flat expansion reports a dozen of that set's squares as colliding with themselves.
 */
function namesOf(file: string): string[][] {
  const raw = JSON.parse(readFileSync(new URL(`../src/data/${file}`, import.meta.url), 'utf8'))
  const squares: RawSquare[] = Array.isArray(raw) ? raw : raw.squares
  return squares.map((square) => {
    let forms = [square.name]
    for (const [key, value] of Object.entries(square)) {
      if (!Array.isArray(value) || !square.name.includes(`%${key}%`)) continue
      forms = forms.flatMap((form) => value.map((v) => form.replaceAll(`%${key}%`, String(v))))
    }
    return [...new Set(forms)]
  })
}

// Mirrors SQUARE_SETS, which cannot be imported here: squareSets.ts pulls in a dozen JSON files
// through the bundler's resolver, and bare JSON imports are not something plain Node will load.
// Variants are listed too - the archive stores their id, so their names have to canonicalize like
// any other set's even though nobody picks one by name.
const SET_FILES = [
  'battleshipChallenges.json',
  'battleshipChallenges2v2.json',
  'incursionSquares.json',
  'rookieRumbleSquares.json',
  'scaduLeagueSquares.json',
  'ringusSquares.json',
]

const live = new Set<string>()
for (const file of SET_FILES) for (const square of namesOf(file)) for (const name of square) live.add(name)

console.log(`\n${live.size} square names across ${SET_FILES.length} sets, ${Object.keys(RENAMED_SQUARES).length} recorded renames\n`)

// -- 1. every rename points at a square that exists ------------------------
//
// The one that actually bites. A target with a typo, or one renamed a second time without its map
// entry being followed on, leaves the old rows pointing at nothing - which is exactly the state the
// map exists to prevent, reached through the map itself.
{
  const dangling = Object.entries(RENAMED_SQUARES).filter(([, to]) => !live.has(to))
  check(
    'every renamed-to name is a square that exists today',
    dangling.length === 0,
    dangling.map(([from, to]) => `"${from}" -> "${to}" (no such square)`).join('; ')
  )
}

// -- 2. no old name is still in use ----------------------------------------
//
// A set that reuses a retired name would have its rows silently rewritten to whatever that name was
// folded into, which is worse than the split it was fixing: it moves history onto a square that
// never earned it.
{
  const revived = Object.keys(RENAMED_SQUARES).filter((from) => live.has(from))
  check(
    'no retired name has been given to a square again',
    revived.length === 0,
    revived.map((from) => `"${from}" is live AND mapped to "${RENAMED_SQUARES[from]}"`).join('; ')
  )
}

// -- 3. renames do not chain -----------------------------------------------
//
// canonicalSquareName resolves exactly one hop, deliberately - a loop would be a hang. So a square
// renamed twice needs its FIRST name pointed straight at its current one, not at the middle name.
{
  const chained = Object.entries(RENAMED_SQUARES).filter(([, to]) => to in RENAMED_SQUARES)
  check(
    'no rename lands on another rename',
    chained.length === 0,
    chained.map(([from, to]) => `"${from}" -> "${to}" -> "${RENAMED_SQUARES[to]}"`).join('; ')
  )
}

// -- 4. the function agrees with the table ---------------------------------
{
  const bad = Object.keys(RENAMED_SQUARES).filter(
    (from) => canonicalSquareName(canonicalSquareName(from)) !== canonicalSquareName(from)
  )
  check('canonicalSquareName is stable when applied twice', bad.length === 0, bad.join('; '))
  check('and passes an unrenamed name straight through', canonicalSquareName('Morgott') === 'Morgott')
  check('and leaves null and undefined alone', canonicalSquareName(null) === null && canonicalSquareName(undefined) === undefined)
}

// -- 5. within one set, a name is never two squares ------------------------
//
// Not about renames, but it is the same wound: an archived row is identified by its name, so two
// squares of one set sharing one would be a single square in every stat the record books keep.
//
// Per set, not across them, because ACROSS is normal and correct - the objective sets overlap
// heavily ("Kill Bayle the Dread" is in three of them) and every reader splits on square_set first,
// so those are already different squares. Only a set colliding with itself is unrecoverable.
{
  const dupes: string[] = []
  for (const file of SET_FILES) {
    const counts = new Map<string, number>()
    for (const square of namesOf(file)) for (const name of square) counts.set(name, (counts.get(name) ?? 0) + 1)
    for (const [name, n] of counts) if (n > 1) dupes.push(`${file}: "${name}" x${n}`)
  }
  check('no set has two squares by the same name', dupes.length === 0, dupes.join('; '))
}

console.log(
  failures === 0
    ? '\nall square name checks passed\n'
    : `\n${failures} check(s) failed - see RENAMED_SQUARES in src/lib/squareSetFormat.ts\n`
)
process.exit(failures === 0 ? 0 : 1)
