/**
 * Checks the pause arithmetic (src/lib/matchPause.ts) and the clock it feeds (src/lib/matchTime.ts).
 *
 * Worth pinning down because the match clock has no state of its own. It is a pure function of a
 * start timestamp and the current instant, so "stopping" it means computing a DIFFERENT instant to
 * read it at - and every way of getting that wrong looks plausible on screen for a few seconds
 * before the digits jump. The properties that actually matter are the joins:
 *
 *   - the clock must not lose or gain a second at the moment it freezes,
 *   - it must restart from exactly where it stopped, not from where it would have been,
 *   - and a room whose host went dark mid-countdown must still resume, on time, everywhere.
 *
 * The last one is the reason the whole thing is derived from two future timestamps rather than from
 * a flag somebody has to flip. There is no client here to flip it.
 *
 * Run with bare Node:
 *
 *   node --experimental-strip-types scripts/check-match-pause.ts
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { pauseInfoAt, pausedMsBefore, pausedMsAt, pauseWindows, closedWindow, readyToResume } =
  await import('../src/lib/matchPause.ts')
const { battlePhaseAt, matchTimeAt, matchTimings } = await import('../src/lib/matchTime.ts')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

/** The match starts at a round number, so every reading below is readable as "T plus n seconds". */
const T0 = Date.parse('2026-08-23T20:00:00.000Z')
const at = (seconds: number) => T0 + seconds * 1000
const iso = (seconds: number) => new Date(at(seconds)).toISOString()

/** Ten seconds of randomization, twenty of preparation, then the match. Small, so T+n is easy. */
const TIMINGS = matchTimings({ starting_seconds: 10, prep_seconds: 20 })
const BEGINS = TIMINGS.matchBeginsAt // 30

/** Seconds on the match clock at a given wall instant, given a room's pause columns. */
function clock(room: Parameters<typeof pauseInfoAt>[0], seconds: number): number {
  const info = battlePhaseAt(iso(0), at(seconds), TIMINGS, pauseInfoAt(room, at(seconds)))
  if (!info) throw new Error('no clock')
  return info.phase === 'match' ? info.matchElapsed : -info.countdown
}

const near = (a: number, b: number, tol = 0.001) => Math.abs(a - b) <= tol

// -- 1. a match nobody stopped --------------------------------------------
{
  const room = { pause_at: null, resume_at: null, pause_log: null }
  check('an unpaused clock is just wall time', near(clock(room, BEGINS + 90), 90), `${clock(room, BEGINS + 90)}s`)
  check('and reads as running', pauseInfoAt(room, at(0)).phase === 'running')
  check('with nothing stopped behind it', pauseInfoAt(room, at(0)).pausedMs === 0)
}

// -- 2. the warning window -------------------------------------------------
// The five seconds between the host pressing pause and the clock actually stopping. This is the
// half that is easiest to get wrong, because the room is visibly "pausing" while the clock must
// still be running - those five seconds are real match time and somebody is fighting through them.
{
  // Host presses pause at T+130 (100s into the match). The freeze lands at T+135.
  const room = { pause_at: iso(135), resume_at: null, pause_log: [] }

  const info = pauseInfoAt(room, at(131))
  check('the warning window reads as pausing', info.phase === 'pausing', info.phase)
  check('and counts down to the freeze', near(info.countdown, 4), `${info.countdown}s`)
  check('but is NOT stopped', info.stopped === false)
  check('so the clock is still running through it', near(clock(room, 131), 101), `${clock(room, 131)}s`)
  check('right up to the last moment', near(clock(room, 134.9), 104.9), `${clock(room, 134.9)}s`)
}

// -- 3. the freeze, and the seam either side of it -------------------------
// A clock that loses or gains a second at the join is the whole failure mode. The reading a
// millisecond before the freeze and the reading ten minutes after it must be the same number.
{
  const room = { pause_at: iso(135), resume_at: null, pause_log: [] }

  check('the clock freezes at pause_at', near(clock(room, 135), 105), `${clock(room, 135)}s`)
  check('and stays there a minute later', near(clock(room, 195), 105), `${clock(room, 195)}s`)
  check('and an hour later', near(clock(room, 3735), 105), `${clock(room, 3735)}s`)
  check(
    'with no seam across the freeze',
    near(clock(room, 134.999), clock(room, 135.001), 0.01),
    `${clock(room, 134.999)} vs ${clock(room, 135.001)}`
  )
  check('and it reads as paused', pauseInfoAt(room, at(200)).phase === 'paused')
  check('with the clock reported stopped', pauseInfoAt(room, at(200)).stopped === true)
}

// -- 4. resuming, without anybody writing anything -------------------------
// resume_at is set once and never touched again. No client tells the others when it lands; each
// works it out. This is what keeps a host who closed their laptop mid-countdown from stranding
// five other people in a match that will not restart.
{
  // Frozen at T+135 (105s on the clock), host resumes at T+295, so the restart lands at T+300.
  // The match was stopped for 165 seconds.
  const room = { pause_at: iso(135), resume_at: iso(300), pause_log: [] }

  const info = pauseInfoAt(room, at(297))
  check('a scheduled restart reads as resuming', info.phase === 'resuming', info.phase)
  check('and counts down to it', near(info.countdown, 3), `${info.countdown}s`)
  check('while the clock is still held', near(clock(room, 297), 105), `${clock(room, 297)}s`)

  check('at the restart it picks up where it stopped', near(clock(room, 300), 105), `${clock(room, 300)}s`)
  check('and runs on from there', near(clock(room, 330), 135), `${clock(room, 330)}s`)
  check(
    'having discounted the whole stoppage, not part of it',
    near(clock(room, 900), 105 + 600),
    `${clock(room, 900)}s`
  )
  check('and it reads as running again', pauseInfoAt(room, at(400)).phase === 'running')
  check(
    'without waiting for the host to write the log',
    pauseInfoAt(room, at(400)).pausedMs === 165000,
    `${pauseInfoAt(room, at(400)).pausedMs}ms`
  )
}

// -- 5. the same match, once the host has tidied up ------------------------
// settlePause moves the window from the two columns into the log. That is bookkeeping, so the
// clock must not so much as twitch when it happens.
{
  const inFlight = { pause_at: iso(135), resume_at: iso(300), pause_log: [] }
  const settled = { pause_at: null, resume_at: null, pause_log: [{ at: iso(135), until: iso(300) }] }

  check(
    'settling the window changes nothing on the clock',
    near(clock(inFlight, 900), clock(settled, 900)),
    `${clock(inFlight, 900)} vs ${clock(settled, 900)}`
  )
  check('and the settled room is plainly running', pauseInfoAt(settled, at(900)).phase === 'running')
}

// -- 6. more than one pause ------------------------------------------------
{
  const room = {
    pause_at: iso(600),
    resume_at: iso(700),
    pause_log: [
      { at: iso(135), until: iso(300) }, // 165s
      { at: iso(400), until: iso(430) }, // 30s
    ],
  }
  // At T+1000: 1000s of wall time, less 30s of buffer, less 165 + 30 + 100 stopped.
  check('stoppages accumulate', near(clock(room, 1000), 1000 - BEGINS - 295), `${clock(room, 1000)}s`)
  check('and the log is read in full', pauseWindows(room).length === 2)
}

// -- 7. a pause called before the fighting starts --------------------------
// RANDOMIZATION and PREPARATION are time windows too, so a pause during either has to hold the room
// where it is. Letting the countdown run out while everybody is away from their desk would open
// fire on an empty room.
{
  const room = { pause_at: iso(15), resume_at: null, pause_log: [] }
  const info = battlePhaseAt(iso(0), at(600), TIMINGS, pauseInfoAt(room, at(600)))
  check('a pause in preparation holds the phase', info?.phase === 'preparation', info?.phase)
  check('and holds its countdown', near(info!.countdown, 15), `${info?.countdown}s`)
}

// -- 8. calling it off during the warning window ---------------------------
// Pressing resume before the freeze lands means the clock never stopped, so there must be no window
// recorded anywhere - not a zero-length one, not a five-second one.
{
  const cancelled = { pause_at: null, resume_at: null, pause_log: [] }
  check('a cancelled pause discounts nothing', near(clock(cancelled, 1000), 1000 - BEGINS), `${clock(cancelled, 1000)}s`)
  check(
    'and leaves no window to bank',
    closedWindow({ pause_at: iso(135), resume_at: null, pause_log: [] }, at(130)) === null
  )
}

// -- 9. a shot fired DURING a pause ----------------------------------------
// Expressly allowed - finish your fight, then quit out - so the clamp is not an edge case, it is
// the normal path for the crew that was mid-boss when the pause went up. Their kill is stamped with
// the clock as it stood when the pause began, not credited with time that had not passed.
{
  const windows = [{ at: iso(135), until: iso(300) }]
  check('a kill during a pause is docked only the part already elapsed', pausedMsBefore(windows, at(200)) === 65000, `${pausedMsBefore(windows, at(200))}ms`)
  check('one before the pause is docked nothing', pausedMsBefore(windows, at(100)) === 0)
  check('and one after it is docked the lot', pausedMsBefore(windows, at(500)) === 165000)
}

// -- 10. banking a window that never got its resume ------------------------
// A host who pauses, drops, comes back and pauses again. The first window really happened and must
// not be overwritten by the second - closedWindow is what pauseMatch banks before it moves pause_at.
{
  const room = { pause_at: iso(135), resume_at: null, pause_log: [] }
  const banked = closedWindow(room, at(400))
  check('an unresolved pause banks up to now', banked?.until === iso(400), banked?.until)
  check('from where it froze', banked?.at === iso(135), banked?.at)
}

// -- 11. junk in the column cannot take the clock down ---------------------
// pause_log is jsonb, which is only as well-typed as whatever last wrote it. This feeds the timer on
// six screens at once; one bad row must cost its own window and nothing else.
{
  const room = {
    pause_at: null,
    resume_at: null,
    pause_log: [
      { at: iso(135), until: iso(300) },
      { at: 'not a date', until: iso(400) },
      null,
    ],
  } as unknown as Parameters<typeof pauseInfoAt>[0]
  check('a malformed window is dropped, not thrown over', pauseWindows(room).length === 1)
  check('and the clock still reads', near(clock(room, 1000), 1000 - BEGINS - 165), `${clock(room, 1000)}s`)
}

// -- 12. who the resume is waiting on --------------------------------------
{
  check('everyone ready is ready', readyToResume([{ pause_ready: true }, { pause_ready: true }]))
  check('one holdout is not', readyToResume([{ pause_ready: true }, { pause_ready: false }]) === false)
  check('and nor is a missing flag', readyToResume([{ pause_ready: true }, {}]) === false)
  // An empty crew reading "ready" would light the host's prompt green in a room with nobody in it.
  check('an empty crew is not ready', readyToResume([]) === false)
}

// -- 13. the battle log agrees with the clock above it ---------------------
// This is the one that got out: both logs measured raw wall time, so every line after a break was
// ahead of the timer beside it by the length of the break. The property to hold is not "the log
// subtracts something" but "the log and the clock never disagree", so that is what is asserted.
{
  const settled = { pause_at: null, resume_at: null, pause_log: [{ at: iso(135), until: iso(300) }] }
  const stamp = (seconds: number) => matchTimeAt(iso(0), iso(seconds), TIMINGS, settled)

  // T+100 is before the pause: 100s in, less the 30s buffer.
  check('a shot before any pause is untouched', stamp(100) === '01:10', stamp(100))
  // T+400 is after it: 400s in, less 165s stopped, less the buffer.
  check('a shot after one is docked the whole window', stamp(400) === '03:25', stamp(400))
}

// -- 14. a kill landing DURING a pause -------------------------------------
// The house rule ("finish your fight") makes this the normal path rather than an edge case - and the
// pause it happened inside is still open, so it is not in the log yet. pausedMsBefore reads the log
// alone and would bill this shot for time that had not passed; pausedMsAt is what closes that.
{
  const open = { pause_at: iso(135), resume_at: null, pause_log: [] }

  check('an open pause counts toward an event inside it', pausedMsAt(open, at(200)) === 65000, String(pausedMsAt(open, at(200))))
  check('but not toward one before it', pausedMsAt(open, at(100)) === 0)
  check(
    'the log alone would have missed it',
    pausedMsBefore(pauseWindows(open), at(200)) === 0,
    'the window is not written until the host settles it'
  )

  // The heart of it: a kill at T+200 is stamped 01:45, and the frozen clock also reads 01:45.
  const stamped = matchTimeAt(iso(0), iso(200), TIMINGS, open)
  check('so the kill is stamped with the frozen clock', stamped === '01:45', stamped)
  check('which is exactly what the clock is showing', near(clock(open, 200), 105), String(clock(open, 200)) + 's')
}

console.log(failures === 0 ? '\nall match pause checks passed' : `\n${failures} match pause check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
