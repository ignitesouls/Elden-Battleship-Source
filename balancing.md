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

Two things, because one of them is not enough.

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
— 23% at 8×8, 21% at 10×10, 28% at 12×12.

## How it works

1. Both teams place and confirm. Nothing can move any more.
2. The clock shows `RANDOMIZATION` for ten seconds, with the board hidden — no names, no tint, no
   legend, for either team or spectators.
3. The server draws a complete random layout, spreads the regions out, and measures both fleets.
4. If either test fails, **it throws the whole layout away and draws another.**
5. The first layout that passes both is the one you play.
6. The board is revealed and `PREPARATION` begins.

Step 4 is the whole design. It does not *fix* a bad board — it discards it and tries again.

## Why it isn't gameable

An earlier version searched: it shuffled squares around until the totals matched. That is learnable,
and it got learned. A search stops the moment it crosses its target, so every board ends up sitting
right on the line. A pass that "corrects" boards leaves a bias you can read.

Drawing and discarding can't do that. The board you play is a uniform sample from the layouts that
pass, indistinguishable from one nothing ever looked at. There is no search to reverse-engineer and
no line to sit against.

The tests bind on most draws — 94% of raw 10×10 deals fail the rank gap — and that is safe for a
reason worth naming: **rejection sampling is unbiased at any threshold.** A tighter test costs
redraws, not neutrality.

What it does cost is inference about the *rule*. A player who knows the two fleets hold roughly equal
numbers of 80-minute squares, and who can see the board and their own fleet, learns something about
the enemy's. That is a real leak, and worth stating. But it is symmetric, it names no cell, and it is
far smaller than the alternative: reading a lopsided board off the screen and knowing the match was
decided before anyone fired.

The measurable version of that: **long squares are no likelier under a hull than on open water**,
14.2% against 13.5% over 200 boards. The earlier searching version leaked exactly here. This is
checked on every run of `scripts/check-board-balance.ts`, and it is the check that matters most.

## What it costs in redraws

Median draws to find an acceptable layout, over 300 boards per size:

| Board | Median | Worst | Failed to find one |
|---|---|---|---|
| 8×8 | 6 | 82 | 0 |
| 10×10 | 15 | 121 | 0 |
| 12×12 | 18 | 218 | 0 |

The budget is 300 draws, and 300 spent draws is about 400ms. If it is ever exhausted the fallback is
the fairest layout of the three hundred — ranked by how far it misses *both* tests together, since
neither outranks the other once both are blown.

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

## Where the tests do not reach

Worth knowing, because it is the reason the second test exists and also the limit of it.

The board that prompted the second test — GHOSTLY HULL, 18 August 2026 — **would still pass today.**
Its rank gap was 3:58 inside a 5:00 limit, the 4th percentile of the whole archive, one of the
fairest boards this has ever produced. What that number could not say was that one fleet had no cell
cheaper than 42 minutes against the other's four under 28, and cost 83 minutes more to clear in
total. The side shooting at it fired all 24 of its enemy's cells and needed the full 98 minutes; the
other side never fired four of its enemy's cells at all.

Counted past 75 minutes those fleets are seven long squares against five. Counted past 80 they are
four against five — inside the limit, and tilted the other way. Three of the expensive squares sat in
the 75–80 band that the line deliberately stops counting.

So: the second test catches boards *like* that one at a rate of one in four or five, and does not
catch that one. Both are true.

There is a deeper limit under it. Across 777 archived sunk ships, a ship's slowest square predicts
when it was actually sunk with a correlation of 0.40 and a residual of nearly eighteen minutes. So a
five-minute threshold sits well inside the model's own noise. That is why the second test counts
whole squares rather than adding more seconds, and why tightening the first one further would buy
nothing real.

## A note on the numbers

Cost is measured behaviour, so it drifts: balance on it and teams route differently, which moves the
very numbers it was drawn from. The table is therefore **frozen within a season** and regenerated
between them, so every match in a tournament is dealt against the same standard.

Current table: 206 squares over 74 archived matches (median length 81:45), Kaplan-Meier restricted
mean capped at a 90-minute horizon, squares seen on fewer than 8 boards falling back to the board
mean of 58:46. Regenerate with `node scripts/build-time-cost.mjs`.

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
