# Elden Battleship — Board Balancing

## What it does

Both teams fire at the same named grid, so the only thing separating a fast match from a slow one is
which bosses happen to land on which team's ships. That used to be decided by a seed struck before
anyone had placed a ship.

Balancing moves the deal to *after* placement, and throws out layouts where one fleet is parked on
squares that take an evening to reach while the other sits on Limgrave.

It never changes **which** bosses are on the board — only where they sit.

## What it costs a square

Not how hard the boss is. **How many minutes of a match it takes before that square is done.**

Measured across every archived match, as the expected time before somebody fires at it. Matches
that ended first count as "took longer than this" rather than as "unreachable". That is a different
claim, and the one the data supports.

| Square | Difficulty tier | Costs |
|---|---|---|
| Starscourge Radahn | 10 | 30:34 |
| Malenia | 20 | 57:49 |
| Caelid Duelist | **7** | **80:27** |
| Bayle | 34 | 87:58 |

Radahn is a wall of a fight and everyone takes him early. Caelid Duelist is an early-tier pushover at
the end of a ride nobody makes, and costs half an hour more than Malenia. The old system priced these
backwards.

A time can be compared with how long a game actually lasts. The
median match runs about 82 minutes, so Bayle does not mean "unreachable" — it means "slightly more
than a whole match", which is a sentence a caster can say and a player can argue with.

The board spans 15:05 to 89:11, with a median square at 57:57.

## What it measures about a fleet

Three things, because no one of them is enough.

### 1. Rank by rank, in minutes

**A ship costs the slowest square on it.** A ship only sinks once every one of its cells has been
fired at, so one expensive cell gates a five-cell Carrier however quick its other four are.

A fleet is then its ships sorted slowest-first, and two fleets are compared **position by position** —
slowest against slowest, cheapest against cheapest. No pair may differ by more than **five minutes**.

Rank by rank rather than by any single summary, because a summary is what let the bad boards through.
One real board had both fleets taking about 86 minutes to eliminate — identical by any maximum,
identical by total to within a few percent. What differed was the bottom of the list: one fleet's
cheapest ship was gated at 76:56, the other's at 50:52. For the first seventy minutes of an
eighty-two minute match, one side could take ships off the board and the other could not. Only a
rank-by-rank comparison sees that.

### 2. Squares that outlast the match

The rank test prices a ship at its slowest square **and throws the rest away**. On a seven-ship,
twenty-four-cell fleet that is seven numbers out of twenty-four, and the comparison then collapses
those seven into one. Two fleets can match on it exactly and be nothing alike — one with four cells
the enemy clears inside half an hour, the other with no cell under forty minutes anywhere.

So the second test counts whole squares instead of measuring seconds:

> **Neither fleet may hold more than one more square costing over 80 minutes than the other.**

Eighty minutes is where the archive falls off. Share of a fleet's cells the enemy eventually got to,
over 3380 archived cells:

| Cost of the square | Eventually fired at |
|---|---|
| under 30:00 | 99% |
| 30:00–45:00 | 98% |
| 45:00–65:00 | 92% |
| 65:00–75:00 | 88% |
| 75:00–80:00 | 80% |
| **past 80:00** | **71%** |

Everything the test counts goes unfired more than a quarter of the time. Squares in the 75–80 band
get finished about four times in five, so they are deliberately *not* counted against the fleet
holding them.

This test rejects between a seventh and a third of the layouts the rank gap alone would have shipped
— 15% at 8×8, 18% at 10×10, 31% at 12×12.

### 3. How long a fleet takes to be *found*

The first two tests both price a ship at its **slowest** square, which is a statement about when it
**dies**. A ship has a second moment that decides matches and neither of them could see: when it is
**found**.

A hull is found the first time anything lands on it, and the enemy gets there through whichever of
its cells they reach soonest. So a ship is found at the price of its **cheapest** square, exactly
where it is cleared at the price of its dearest. One warm cell on a five-cell Carrier gives the whole
hull away at that cell's price, however cold the other four are.

Everything that makes the middle of a match happens between those two events — the enemy knowing
there is a hull around D7, working out which way it lies, spending shots picking it apart. A fleet
nobody can find for fifty minutes is playing a different game from one found at twenty, whatever
happens afterwards.

> **Fleets are compared rank by rank on that too, and no pair may differ by more than ten minutes.**

**This is not the first test restated.** Over 2107 archived ships, a hull's cheapest square
correlates with its slowest at **r = 0.192**, and the two sit a median of **30:42** apart. Against
what actually happened, over 2018 archived ships the enemy ever hit:

| Priced at the ship's | predicts when it was FOUND | predicts when it was CLEARED |
|---|---|---|
| **cheapest** square | **r = 0.499** | r = 0.233 |
| **slowest** square | r = 0.157 | **r = 0.438** |

Read the diagonal. Each end predicts its own moment and neither predicts the other's. It is also the
better-supported of the two models — a find is predicted at r = 0.499 with a residual of 17:47,
against the slowest square's r = 0.438 and 16:41 on a clear.

It is min and not mean for the same reason: the mean square comes in at r = 0.442 on find time,
*behind* the minimum, because averaging a cold cell against a warm one describes a ship the enemy
never has to fight.

#### Why ten minutes and not five

Symmetry says five. Five is not reachable, and the reason is worth knowing before anyone suggests it
again.

A ship's cheapest square spreads **wider** than its slowest — sd 13:13 against 10:49, and a
within-fleet range of 30:03 against 24:32. The maximum of five cells piles up against the top of the
cost table wherever it is drawn from; the minimum has the whole low tail to fall down. So the same
number of seconds is a harsher test on this end: of 600 raw 10×10 deals, 6.7% come in under a 5:00
rank gap and only 2.8% under a 5:00 find gap.

And all three tests must pass on the **same draw**, so their acceptance rates multiply. On the
900-draw budget that ships, over 60 boards per cell:

| Find limit | 10×10 draws (median / p90 / worst) | Boards that ran out of draws |
|---|---|---|
| 5:00 | 494 / 900 / 900 | 37% at 10×10, 45% at 12×12 |
| 7:00 | 195 / 639 / 900 | 5% at 10×10, 10% at 12×12 |
| **10:00** | **55 / 237 / 389** | **none, at any size** |

Five minutes does not produce fairer boards. It produces boards that spend the whole budget and then
play the fairest layout drawn anyway — and a fallback is not a uniform sample from the layouts that
pass, which is the one property this whole design exists to keep.

Ten is also inside the model's own noise, which is what makes it honest rather than merely
affordable: a little over half of one 17:47 residual, the same kind of claim as the rank gap's five
against its 16:41.

**It is by a distance the most interventionist rule here** — it redraws **71–73%** of the layouts
the other two tests would have shipped, against the long-square test's 15–31%. That is a statement
about how much of a ship the first two tests were missing, not about the threshold being severe.

## How it works

1. Both teams place and confirm. Nothing can move any more.
2. The clock shows `RANDOMIZATION` for ten seconds, with the board hidden — no names, no tint, no
   legend, for either team or spectators.
3. The server draws a complete random layout, spreads the regions out, and measures both fleets.
4. If any test fails, **it throws the whole layout away and draws another.**
5. The first layout that passes all three is the one you play.
6. The board is revealed and `PREPARATION` begins.

Step 4 is the whole design. It does not *fix* a bad board — it discards it and tries again.

## Why it isn't gameable

An earlier version searched: it shuffled squares around until the totals matched. That is learnable,
and it got learned. A search stops the moment it crosses its target, so every board ends up sitting
right on the line. A pass that "corrects" boards leaves a bias you can read.

Drawing and discarding can't do that. The board you play is a uniform sample from the layouts that
pass, indistinguishable from one nothing ever looked at. There is no search to reverse-engineer and
no line to sit against.

The tests bind on most draws — 94% of raw 10×10 deals fail the rank gap, and 97% fail the find gap — and that is safe for a
reason worth naming: **rejection sampling is unbiased at any threshold.** A tighter test costs
redraws, not neutrality.

What it does cost is inference about the *rule*. A player who knows the two fleets hold roughly equal
numbers of 80-minute squares, and who can see the board and their own fleet, learns something about
the enemy's. That is a real leak, and worth stating. But it is symmetric, it names no cell, and it is
far smaller than the alternative: reading a lopsided board off the screen and knowing the match was
decided before anyone fired.

The measurable version of that: **long squares are no likelier under a hull than on open water**,
13.2% against 14.0% over 200 boards — and the third test did not move it. The earlier searching
version leaked exactly here. This is checked on every run of `scripts/check-board-balance.ts`, and it
is the check that matters most.

## What it costs in redraws

Draws to find an acceptable layout with all three tests applied, over 60 boards per size:

| Board | Median | p90 | Worst | Failed to find one |
|---|---|---|---|---|
| 8×8 | 26 | 111 | 256 | 0 |
| 10×10 | 56 | 201 | 295 | 0 |
| 12×12 | 75 | 265 | 628 | 0 |

The budget is **900 draws**, raised from 300 when the find test landed — each test is a separate
hurdle on the same draw, so a third one costs more budget than it looks like it should. A draw is
1.67ms on a 10×10, so the ordinary deal is about 90ms and a fully spent budget is about 1.5 seconds,
inside the ten the room waits.

A sweep of every board size against every fleet preset put the hardest board of 150 at 651 draws, and
none failed. If the budget is ever exhausted the fallback is the fairest layout of the nine hundred —
ranked by how far it misses *all three* tests together, since none outranks another once all are
blown.

## Regions get spread out regardless

Every candidate layout is declumped before it is ever scored, so you don't get eight DLC bosses in
one corner of the grid. Worst 3×3 patch drops from about 5.0 same-region squares to about 3.4.

This runs on every board, not just unfair ones, and the secrecy reasoning above doesn't apply to it:
crowding is a property of the board everyone is about to look at anyway. It doesn't know where a
single ship is.

It also stops short of a perfect sprinkle on purpose. A board driven to its true minimum stops
looking dealt and starts looking sorted.

## What it deliberately does not do

**It won't stop you drawing an awkward square.** Consort Radahn can still appear with neither Messmer
nor Romina on the board. Which squares are in play is a property of the seed, and no rearrangement
can change that — only where they sit. (A prerequisite that *is* on the board discounts the square
needing it, since the measured time already assumed the prerequisite was a separate trip.)

**It doesn't even out every board.** A team holding Consort while the other holds Adula, Alecto and
Bayle is a fair match, and it's left alone.

**It is not calibrated for three or four teams.** Both thresholds were swept on two-team boards. The
gap is a spread across every fleet, so each extra fleet is another way to be the outlier: three-team
boards exhaust the budget often and four-team boards nearly always, falling back to the fairest
layout drawn. Playable, and better than the raw deal every time, but a weaker guarantee. Don't trust
it until the limits have been swept per team count.

**It's off for the objective square sets.** Those have no cost data, and it refuses rather than
guessing.

**If the balancer is unavailable, the match plays anyway** — as a plain seeded deal, exactly the game
as it played before any of this existed.

## The board that got away, and what finally caught it

GHOSTLY HULL, 18 August 2026, is the board the second test was built after — and the board the second
test could not catch. It is worth walking through, because it is the whole argument for the third one
and it is not a hypothetical.

Its rank gap was **3:58** inside a 5:00 limit: the 4th percentile of the entire archive, one of the
fairest boards this has ever produced. Its long-square gap was **1**, exactly on the line. By both
shipped tests it was a good board.

It was not a good board. One fleet had no cell cheaper than 42 minutes against the other's four under
28, and cost 83 minutes more to clear in total. The side shooting at it fired all 24 of its enemy's
cells and needed the full 98 minutes; the other side never fired four of its enemy's cells at all.

For two years the honest thing to say about the second test was that it catches boards *like* that
one and does not catch that one. Counted past 75 minutes those fleets are seven long squares against
five; counted past 80 they are four against five — inside the limit, and tilted the *other way*.

Here is why. These are its two fleets, scored with today's model:

| | when its ships were **cleared** | when its ships were **found** |
|---|---|---|
| One fleet | 89:11 85:10 84:05 81:59 74:13 67:45 59:49 | 55:44 53:02 48:18 **27:25 26:46 23:38 21:50** |
| The other | 86:10 85:10 80:07 79:27 76:56 68:14 62:54 | 55:10 51:38 49:14 **45:38 45:21 43:16 42:21** |

The left column interleaves — that is the 3:58. The right column comes apart at rank 4 and stays
apart: four ships one side could stumble on inside half an hour, against four the other side would
not be touched on for three quarters of one.

**Find gap 20:31, against a 10:00 limit.** It fails by more than double. The board that defined the
limits of this system is now rejected on the first thing measured about it.

Across all 146 scorable archived boards, of the 68 that pass both of the older tests, **49 fail the
find gap.**

### The limit under all of it

Both models are weak, and knowing how weak is what keeps the thresholds honest. Re-measured over the
current archive: across 1713 ships the enemy cleared, the slowest square predicts when it was cleared
at r = 0.438 with a residual of **16:41**; across 2018 ships the enemy ever hit, the cheapest square
predicts when it was found at r = 0.499 with a residual of **17:47**.

So every threshold here sits well inside its own model's noise — five minutes against seventeen, ten
against eighteen. That is deliberate, and it is why the second test counts whole squares rather than
adding more seconds, why the first stops at five minutes, and why the third stops at ten. Enforcing
anything finer would be enforcing a distinction the cost table cannot make.

## A note on the numbers

Cost is measured behaviour, so it drifts: balance on it and teams route differently, which moves the
very numbers it was drawn from. The table is therefore **frozen within a season** and regenerated
between them, so every match in a tournament is dealt against the same standard.

Current table: 206 squares over 74 archived matches (median length 81:45), Kaplan-Meier restricted
mean capped at a 90-minute horizon, squares seen on fewer than 8 boards falling back to the board
mean of 58:46. Regenerate with `node scripts/build-time-cost.mjs`, or run it with `--dry-run` to see
what it *would* say without restating the table mid-season.

### Matches since Dionysus count for more

Dionysus went out at 10:00 on 21 Aug 2026 alongside the changes that made boards faster, and a cost
is measured behaviour — so a match played before it describes a game that no longer exists.

It cannot simply be discarded: the entire archive predates the cutoff, so a filter would leave nothing
to price 206 squares with. Instead the estimator is **weighted**. A post-cutoff observation counts in
full; an earlier one is discounted by how much new evidence *that square* has of its own:

| Post-Dionysus boards for a square | What one older board is worth |
|---|---|
| 0 | 1.00 |
| 12 | 0.50 |
| 40 | 0.23 |
| 68 or more | 0.15 (the floor) |

Per square, because squares do not arrive at the same rate — on a 10×10 any one lands on about half
of boards, and the rare ones would sit on three observations for weeks if one global counter decided
when to stop listening to the old data. Floored rather than zeroed, so a square that goes quiet keeps
its history instead of having it erased by a dozen new boards somewhere else.

Uniform weights change nothing, which is what makes this safe to leave switched on: while no
post-cutoff match exists, every observation is discounted equally and the table is exactly the one
the unweighted estimator wrote. The bias arrives with the data rather than with the constant.

Each run reports how far the changeover has got — how many squares have crossed 8 post-Dionysus
boards, and how far their blended price sits from what their new evidence alone would say. While
those agree there is nothing to decide. When they part company and the gap stops moving between runs,
the old archive is holding the table back, and `RECENT_TARGET` or `OLD_FLOOR` in
`scripts/build-time-cost.mjs` should come down.

### Renaming a square costs history

The archive identifies a square by its **name**, so renaming one splits its record in two unless the
old name is folded into the new — see `RENAMED_SQUARES` in `src/lib/squareSetFormat.ts`.

That matters here specifically. Costs are rebuilt by replaying each archived match onto today's board
and checking the names line up; a match that disagrees too much is thrown out **whole**, taking every
square on its board out of the estimate. Unrecorded renames therefore don't skew the table, they
shrink it — quietly, and toward squares falling back to the board mean.

So before regenerating, run:

```
node scripts/audit-square-names.mjs
```

It reports any name in the archive that no longer lands on a square. Every one it prints is history
that currently counts toward nothing. `npm run check` covers the offline half — that the renames
which *are* recorded still point somewhere real.
