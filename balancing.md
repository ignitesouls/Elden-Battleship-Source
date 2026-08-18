# Elden Battleship — Board Balancing

## What it does

Both teams fire at the same named grid, so the only thing separating a fast match from a slow one is
which bosses happen to land on which team's ships. That used to be decided by a seed struck before
anyone had placed a ship.

Balancing moves the deal to *after* placement, and throws out layouts where one fleet is parked on
squares nobody can realistically reach while the other sits on Limgrave.

It never changes **which** bosses are on the board — only where they sit.

## What it costs a square

Not how hard the boss is. **How often anyone actually gets to it.**

Measured across every archived match: the share of boards a square appeared on where somebody fired
at it. That single number quietly absorbs travel time, gating, and prerequisite bosses that may not
even be on the board.

| Square | Difficulty tier | Actually reached |
|---|---|---|
| Starscourge Radahn | 10 | **100%** |
| Malenia | 20 | 67% |
| Caelid Duelist | **7** | **18%** |
| Bayle | 34 | 13% |

Radahn is a wall of a fight and everyone takes him. Caelid Duelist is an early-tier pushover at the
end of a ride nobody makes. The old system priced these backwards.

### Cold cells

A square is **cold** when nobody realistically kills that boss during a match, so its cell never gets
fired at.

You only fire at a square by killing the boss named on it. Bayle is killed on 13% of the boards he
appears on, so Bayle's cell goes unfired on roughly 87% of matches. **If your ship covers that cell,
that part of your ship is never shot at — and the enemy cannot finish sinking it.**

That is the real fairness problem, and it isn't about speed. A fleet sitting on several cold cells
can't be *completed*, however well the other team plays.

A fleet's **burden** is the sum of `1 − reach` over its 17 cells: how many of them are cold. A
typical fleet carries about 5.3, and a higher burden is safer for the fleet that has it.

## How it works

1. Both teams place and confirm. Nothing can move any more.
2. The clock shows `RANDOMIZATION` for ten seconds, with the board hidden — no names, no tint, no
   legend, for either team or spectators.
3. The server draws a complete random layout, spreads the regions out, and measures both fleets.
4. If either fleet is much worse off, **it throws the whole layout away and draws another.**
5. The first layout that isn't lopsided is the one you play.
6. The board is revealed and `PREPARATION` begins.

Step 4 is the whole design. It does not *fix* a bad board — it discards it and tries again.

## Why it isn't gameable

The previous version searched: it shuffled squares around until the totals matched. That is
learnable, and it got learned. A search stops the moment it crosses its target, so every board ends
up sitting right on the line — and a pass that "corrects" boards leaves a bias you can read.

Drawing and discarding can't do that. The board you play is just a normal random layout that
happened to pass, indistinguishable from one nothing ever looked at. There is no search to reverse
engineer and no line to sit against.

Two consequences worth knowing:

- **On a 10×10, about 19 boards in 20 are accepted on the first draw** — the fairness test never even
  binds, and the layout was picked without reference to anybody's ships.
- **Cold squares are no rarer under a hull than on open water** (14.8% vs 15.4%). The old
  version leaked exactly here; there is now nothing that could create the bias.

The only thing anyone can infer is the rule itself: the two fleets differ by at most about 2.5
cold cells out of ~5.3. That's deliberately vague, and it stays vague.

## Small boards are held to a stricter standard

The **gap** is the difference between the best-off and worst-off fleet's burden. On a 10×10:

```
Team A's 17 squares →  6.8 cold cells
Team B's 17 squares →  4.6 cold cells
                       ────
gap                    2.2   ✓ under 2.50, so this layout is played
```

Had B's come out at 4.0, the gap would be 2.8, and the layout would be discarded and redrawn. The
number is fractional because it's an expectation — a square reached 30% of the time contributes 0.7,
not a whole cell.

The allowance is a flat fraction of your fleet, which automatically tightens as boards shrink — on a
seven-cell fleet one cold square is a seventh of everything you own, while a 25-cell fleet
averages its bad luck out.

| Board | Fleet | Allowed gap | Boards it corrects |
|---|---|---|---|
| 6×6 | 9 | 1.32 cells | 14% |
| 8×8 | 12 | 1.76 cells | 9% |
| 10×10 | 17 | 2.50 cells | 5% |
| 12×12 | 25 | 3.68 cells | 2% |

Against a typical burden of 5.3, an allowance of 2.5 lets one team be roughly half a fleet's worth
harder to sink than the other. That is loose on purpose: a test that rarely binds is a test that
gives almost nothing away.

## Regions get spread out regardless

Every candidate layout is declumped before it's ever scored, so you don't get eight DLC bosses in one
corner of the grid. Worst 3×3 patch drops from 4.9 same-region squares to 3.4.

This runs on every board, not just unfair ones, and it's exempt from all the secrecy reasoning above
for a simple reason: crowding is a property of the board everyone is about to look at anyway. It
doesn't know where a single ship is.

It also stops short of a perfect sprinkle on purpose. A board driven to its true minimum stops
looking dealt and starts looking sorted.

## What it deliberately does not do

**It won't stop you drawing an awkward square.** Consort Radahn can still appear with neither Messmer
nor Romina on the board. Which squares are in play is a property of the seed, and no rearrangement
can change that — only where they sit.

**It doesn't even out every board.** A team holding Consort while the other holds Adula, Alecto and
Bayle is a fair match, and it's left alone. The test only fires when one side's run is meaningfully
longer than the other's.

**It's off for the objective square sets.** Those have no reachability data, and it refuses rather
than guessing.

**If the balancer is unavailable, the match plays anyway** — as a plain seeded deal, exactly the game
as it played before any of this existed.

## A note on the numbers

Reachability is measured behaviour, so it drifts: balance on it and teams route differently, which
moves the very numbers it was drawn from. The table is therefore **frozen within a season** and
regenerated between them, so every match in a tournament is dealt against the same standard.

Current table: 51 archived matches, 13–32 boards per square. Regenerate with
`node scripts/build-reachability.mjs`.

### Renaming a square costs history

The archive identifies a square by its **name**, so renaming one splits its record in two unless the
old name is folded into the new — see `RENAMED_SQUARES` in `src/lib/squareSetFormat.ts`.

That matters here specifically. Reachability is rebuilt by replaying each archived match onto today's
board and checking the names line up; a match that disagrees too much is thrown out **whole**, taking
every square on its board out of both the numerator and the denominator. Unrecorded renames therefore
don't skew the table, they shrink it — quietly, and toward squares falling back to the neutral prior.

So before regenerating, run:

```
node scripts/audit-square-names.mjs
```

It reports any name in the archive that no longer lands on a square. Every one it prints is history
that currently counts toward nothing. `npm run check` covers the offline half — that the renames
which *are* recorded still point somewhere real.
