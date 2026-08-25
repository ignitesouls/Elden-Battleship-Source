# Honors

Every title the match recap can hand out, in the order they are awarded. Source of truth is the
`HONORS` list in [src/lib/matchReport.ts](src/lib/matchReport.ts); the checks that pin the rules down
are in [scripts/check-honors.ts](scripts/check-honors.ts) (`node --experimental-strip-types
scripts/check-honors.ts`).

## How they are handed out

- **Everything is earned.** Nothing is positional or random — a title is only ever offered to players
  whose log actually shows the deed, so the same match always produces the same honors on every
  client, and a player who did nothing measurable simply gets nothing.
- **One honor per player, one player per honor.** The list is walked top to bottom; the first player
  who qualifies and isn't already holding something takes the title.
- **Ranked titles cascade.** They describe a role, so if the leader is already spoken for the
  runner-up takes it and the detail line states *their* number, not the leader's.
- **Singular titles don't.** They describe one specific event (first blood, the last kill). If its
  owner already holds an honor, the title simply doesn't appear that match.
- **Floors keep noise out.** "Best accuracy" off one lucky shot isn't a distinction, so most honors
  carry a minimum sample and the honors below them pick up whoever the floors exclude.

Ship-level honors need a hull's footprint, which is rebuilt from the sinking row (`sunk_start_*`).
Ships still afloat at the end can't be reconstructed at all, so every ship honor here is about a ship
that sank.

Eight of these hang on five creatures — the Dutchman, the bottles,
Alexander, Patches and Igon all live in [src/lib/deepWater.ts](src/lib/deepWater.ts) alongside the
whale and the tentacles. Four of the five are hidden and found by exactly the same machinery. Igon is
not: nothing rolls his square, nothing keeps it secret, and he is simply wherever the first miss
beside the arena turns out to be — see **Igon** below.

**Beachcomber is the one exception to the rarity ordering below, and it is deliberate.** There are
four bottles in the water rather than one, so it is noticeably easier to earn than the three finds it
sits beside at 10–13. It stays where it is because the note is the point of it: a title that mostly
exists to carry a message somebody left on the sea floor should not be ranked as though it were a
trophy.

## The list

The list runs in three tiers, and the numbering is the walk order — #1 gets first claim on a player,
#39 gets whatever nobody above it took.

### The one that outranks everything

The hardest thing on the list, and the only title ranked above what the water was hiding.

| # | | Title | Earned by | Kind |
|---|---|---|---|---|
| 1 | 🐐 | **Shaker's Protégé** | Every ship in an enemy fleet, every killing blow theirs. Needs the room's fleet recorded, a crew of **three or more**, and one crewmate stealing one finish ends it. | Ranked (a two-fleet sweep outranks one) |

### What the water was hiding

Squares nobody was told about and nobody could aim for. None of it can be earned by playing well,
which is exactly why it outranks everything that can.

**Ordered by rarity, #2 the rarest.** Within the tier that is the only ranking principle — a hunt
nobody finishes in fifty matches should not be read out after one that turns up most nights. The
rungs of each hunt still cascade, so two crewmates on three tentacles each take the top two.

| # | | Title | Earned by | Kind |
|---|---|---|---|---|
| 2 | 🦑 | **High Priest of R'lyeh** | Found every one of Cthulhu's tentacles alone and woke the sleeper. | Ranked |
| 3 | 🌀 | **Woke the Sleeper** | Landed the last tentacle, whoever else did the digging. | Singular |
| 4 | 🐉 | **Tormented No Longer** | Killed Bayle carrying one of Igon’s fingers, and put his grudge to rest. | Singular |
| 5 | 👻 | **Thrice-Cursed** | Sighted the Flying Dutchman 3 or more times in one match. | Ranked |
| 6 | 🔮 | **Acolyte of the Sleeper** | Found 3 tentacles, short of the full set. | Ranked |
| 7 | 💪 | **Potfriend** | Shot Alexander loose from the shallows he was wedged in. | Singular |
| 8 | 🐳 | **Wrong Whale** | Put a cannonball into Laboon, who did not mind. | Ranked |
| 9 | 💤 | **Dreamer of R'lyeh** | Found 2 tentacles. | Ranked |
| 10 | 🐋 | **Captain Ahab** | Found the white whale — one unmarked square on the whole board. | Singular |
| 11 | ⛵ | **Sighted the Dutchman** | The first sail seen, with nothing under it. | Singular |
| 12 | 📜 | **Beachcomber** | Fished a bottle out of the sea — four squares on the whole board, and a message nobody asked for. | Singular |
| 13 | 🏺 | **Found the Jar** | Turned up Alexander, wedged and going nowhere, and left him there. | Singular |
| 14 | 🏹 | **Igon's Furled Finger** | Fired the miss that turned Igon up beside the arena, and took the finger no further. | Singular |
| 15 | 🙇 | **Ahh, So It's You** | Reached for a tentacle and got Patches. He is "sorry". | Ranked |
| 16 | 🕯️ | **Whispers in the Deep** | Found one tentacle — something down there. | Ranked |

### Everything the shooting earns

Read off the scoreboard or the shape of somebody's shots.

The first three describe a player's whole match rather than a moment in it, and lead the tier in that
order. From #20 down the order is not a ranking. Which of those a player is handed depends on what
their log happened to show.

| # | | Title | Earned by | Kind |
|---|---|---|---|---|
| 17 | 📖 | **Ishmael** | The best gun on a fleet that went down with all hands. One claim per wreck, and only for someone who landed something. | Ranked |
| 18 | ⚓ | **Admiral of the Fleet** | Most ships sunk. In a match where nothing sank, most hits. | Ranked |
| 19 | 🐙 | **Captain Nemo** | Sank a ship alone — every hit on that hull theirs, and the kill. Any hull counts; ranked by how many, then by the biggest. | Ranked |
| 20 | 🏴 | **Struck the Colors** | The blow that ended the match. | Singular |
| 21 | 🛳️ | **Slayer of the Leviathan** | Sank the largest hull that went down, 4+ squares. A Cruiser is not a leviathan. | Ranked |
| 22 | 🪝 | **The Old Man and the Sea** | 3+ hits poured into one particular hull. A chase that never landed the kill outranks one that did. | Ranked |
| 23 | 📡 | **The Hunt for Red October** | Sank the Submarine. Nothing for the presets that field none. | Ranked |
| 24 | 🪡 | **Needle in the Haystack** | Dug the smallest hull on the board — 2 squares — out of open water. | Ranked |
| 25 | 🗡️ | **Coup de Grace** | Finished hulls another gunner had already wounded. | Ranked |
| 26 | 💣 | **Master Gunner** | Most hits landed (2+). | Ranked |
| 27 | 🎯 | **Dead Reckoning** | Longest run of hits, 3+ in a row. | Ranked |
| 28 | 🔭 | **Sharpest Eye in the Crow's Nest** | Best accuracy, over at least 3 shots. | Ranked |
| 29 | 🧨 | **Opening Broadside** | Drew first blood. | Singular |
| 30 | 🌊 | **Davy Jones' Pen Pal** | 5+ shots at under 34% accuracy — most shots fed to the fish. | Ranked |
| 31 | 🕳️ | **Water, Water, Everywhere** | Longest run of misses, 4+ straight into open water. | Ranked |
| 32 | 💥 | **Raking Fire** | One shot that struck 2+ fleets at once (3+ team rooms only). | Ranked |
| 33 | ❌ | **X Marks the Spot** | Their own first shot of the match found a hull. | Ranked |
| 34 | 🗺️ | **Cartographer of the Narrow Sea** | 6+ shots spread over more rows and columns than anyone else. | Ranked |
| 35 | 🎣 | **Trawler** | 5+ shots worked into one patch of sea, a quarter of the board or less. | Ranked |
| 36 | 🪨 | **Hugger of the Shoals** | 4+ shots along the rim, and over 60% of everything they fired. | Ranked |
| 37 | ⚡ | **Quickest Powder** | Two shots 5 seconds or less apart. | Ranked |
| 38 | 🧭 | **Das Boot** | 3+ shots with 30 seconds or more of chartwork between them. | Ranked |
| 39 | 🐒 | **Powder Monkey** | Most shots fired (5+). The wooden spoon: volume, and nothing else. | Ranked |


## Why the tiers, and not just a list

One honor per player means a four-shooter match hands out four titles, whatever the rest of the list
says. So placement isn't decoration. It decides which of the true things about a player is the one
that gets said, and moving a title up doesn't add anything: it takes whatever used to win them.

That is the whole argument for the top two tiers. One title sits above the water, because sweeping a
fleet single-handed is rarer than most of what is down there and harder than all of it. Everything
the shooting earns sits below, because a find can't be aimed for: someone who put a cannonball into
Laboon should hear about Laboon, not about having the third-best accuracy. Below #20 the ordering
carries no claim at all.

The Admiralty, Ishmael and Captain Nemo used to sit above the water too, and moving them down is a
correction rather than a demotion: they still lead everything the shooting earns. The match that
settled it turned up the Flying Dutchman and a message in a bottle, and read out four shooting titles
over the top of them; the recap named a sail its own board wasn't drawing. The three best gunners in
a six-player room are exactly the people most likely to be sitting on a find, so ranking anything
aimable above the water quietly eats the rarest thing the match produced.

## Notes on the two that need the room's fleet

**Shaker's Protégé** and **Ishmael** are the only honors that can't be read off the attack log alone.
Both hang on a fleet being *wiped out*, and "sank every hull that went down" is a much cheaper claim
than "sank every hull they had" — so both need `ship_defs` to tell the two apart, and neither appears
at all for a room archived without it (see `wipedFleets` in matchReport.ts). The count scales with the
board: five ships on a 10x10 Classic room, three on a small one, because a fleet is whatever
`fleetFor()` dealt that room.

**Shaker's Protégé** sits at #1 on purpose, above the water and everything else. Anyone who sweeps a
fleet is also the top sinker, so ranked below the Admiralty they would be handed "sank the most ships"
while the far better story went untold. It is the hardest title on the list to get: it takes both the
shooting and a whole match in which nobody on your own side closes out a single hull. The icon is 🐐
rather than the man himself: Unicode has no Faker, and the GOAT is as close as the emoji set gets.

It takes a crew of three, and that floor is not decoration. The claim is that nobody ELSE on your side
closed out a hull, and in a duel there is nobody else - so the title was unconditional for whoever won,
and all four times it was ever awarded were crews of one. The last of those went to a fleet that a bug
had wiped off the board mid-battle, so its owner could not be hit, could not be sunk, and could not
lose. Three is the same line bossSetForRoster already draws between a small room and a full one, and
those four titles were taken back off the record when the floor landed.

**Ishmael** is the opposite end of the same match — "and I only am escaped alone to tell thee". It is
one claim per wrecked fleet rather than a cascade: a crewmate who did less is a worse survivor than
the wreck deserves, so if the best gun on that fleet already holds a title, the honor goes unawarded.
It sits above the Admiralty for the same reason Protégé does — a losing crew's best would otherwise be
handed "most hits landed" as though the night had gone fine.

## Notes on the deep-water additions

Four new creatures, six new titles, and one deletion. All of it rides the machinery already in
`deepWater.ts` — a square per creature, rolled out of the open water when the fleets are confirmed
and found by firing at it — so none of it needs an honor-specific column or table.

### The old Flying Dutchman honor is gone

There used to be a shooting honor called **The Flying Dutchman**, holding 👻: 3+ hits and 6+ shots
without ever sending a ship under — cursed to sail on, never making port. A good name right up to the
moment an actual Dutchman started appearing in the water. Two unrelated things under one name, one a
marker a player can see and the other a scoring quirk they can't, is the kind of collision that makes
a recap unreadable: a player who saw the ghost ship would go looking for the ghost-ship honor and find
one describing their accuracy.

It was **deleted rather than renamed**, and the 👻 it was holding went to Thrice-Cursed. Nothing
replaces it in the shooting tier. The gunner who wounds and never finishes is already covered there —
**Coup de Grace** names the player who kept taking those kills off them, and **Master Gunner** and
**Sharpest Eye** both catch someone landing hits — so the slot was carrying a distinction the tier
could already make.

**Davy Jones' Pen Pal (#30) stays.** Davy Jones captains the Dutchman in one telling, but the honor
names the locker, not the ship, and "gone to Davy Jones" is an idiom about the bottom of the sea that
predates any of it. One deletion was forced; a second would be tidying.

### How the tier was ordered

Rarest first, and the ladder is roughly: sweeping all four tentacles alone (2) is the hardest thing
on the board; waking the sleeper at all (3) needs all four found by anybody; killing Bayle with Igon
watching (4) needs two rare things in one match and is dealt with in its own section below; three
Dutchman sightings (5) needs three separate sail squares reached, since nothing about him can be
caught and every crew that fires at one meets him. Below those the single finds cluster together —
the whale, the first sail and the jar are each one square of the open water and therefore about
equally likely, so **10–13 is a tie broken on story**: Moby Dick first, then the ghost ship, then the
curio, then the jar somebody walked away from.

Two placements are worth defending because they look wrong:

- **Wrong Whale at 8, above the whale itself at 10.** One whale square in five is Laboon instead,
  rolled when the square is, so he is strictly rarer than Moby Dick — you have to reach the whale's
  square *and* have lost the roll. Ranking him above the animal he is standing in for reads oddly
  and is nonetheless correct.
- **Whispers in the Deep at 16, last.** One tentacle out of four is close to a coin-flip's worth of
  searching; on most boards somebody finds one. It is the most common thing in the tier by a wide
  margin, and last is where the rule puts it.

### Alexander's two titles are both Singular

He is the first two-stage egg — Igon is the second, and borrows this shape wholesale — so he carries
two honors describing two specific events: the shot that
found him (**Found the Jar**, 13) and the later adjacent shot that freed him (**Potfriend**, 7). Both
are Singular, and the consequence is deliberate — **a player who does both takes Potfriend, and Found
the Jar does not appear at all**. Freeing him is the whole deed; being also told you found him is the
participation ribbon this list doesn't hand out.

The gap between them is the rarity rule doing its job. Freeing him needs his square found *and* a
later miss on one of the four squares beside it, which is a second condition on top of an already
uncommon find; leaving him wedged is just the find. Six places apart is what that difference is worth.

Both shots have to come from **the crew that found him**, and that is a visibility rule rather than a
flavour one. His square is only ever drawn for the crew that turned him up, so a rescue by anyone else
would break in both directions at once: the crew who fired the shot would watch nothing happen, and
the crew watching his square would see it redraw off a shot they never fired — which quietly tells
them that a square beside him is open water.

**Potfriend** rather than "Iron Fist's Friend": it is what a jar calls someone who has done it a
kindness, and it is the better line.

### Igon

Two honors, and the only pair here that hangs on something the roll never placed.

He is **met, not caught**. The first shot beside Bayle's square that comes back a miss is where Igon
turns out to have been all along, and every crew that fires there afterwards meets him too — and
every one of them walks away with a furled finger, because that is what he has and what he wants
somebody to use. So both titles are per crew, and arriving second is worth something, which is
unusual: a whale, a tentacle and a bottle are all gone once the first crew reaches them.

**Igon's Furled Finger** (14) is the consolation half, and it sits where **Found the Jar** sits for
exactly the same reason: it is what a crew is left holding when they turned something up and never
finished it. It is cheap on its own — one miss on one of at most four squares, on a board that
dealt the arena at all — which is why it ranks below the single finds rather than above them. The
whale is one unmarked square in a hundred; Igon is hard to *avoid* once you are in the neighbourhood.

**Tormented No Longer** (4) is what the finger is for, and what earns rank 4 is the dragon rather
than the man. Bayle is one of the most expensive squares in the set — *bossTimeCost* has him at
5278 and *bossReachability* at 0.133, both at the far end — and the board has to have dealt him at
all, which is roughly one 10×10 in two and never on the small-crew boss board, which cuts him.

**Both halves are the same crew's**, the way Alexander's are. A crew carrying a finger kills their
own dragon; another fleet killing Bayle is not their vengeance, it is somebody else's boss.

That is the house rule for every two-stage egg on this list and it is not negotiable per-egg. An egg
whose halves can be collected by different people is not one egg with two stages — it is two eggs
sharing a name, where neither crew did the thing and the honor at the end describes a deed nobody
performed. Here the flavour happens to agree with the rule for once: he wants the dragon dead, and he
does not much mind how many people help.

The two can still arrive in the wrong order. A crew that killed Bayle earlier and only later fires
beside the arena meets him already on his feet — it was still their kill, so the deed is done
either way round.

### Patches

**Ahh, So It's You** (15) is the same joke as **Wrong Whale** — a hunt that resolves into something
harmless — but it sits seven places lower, because there are four tentacles rolling for him against the
whale's one, and four chances at a 20% substitution is a much easier thing to land than one. Ranked
rather than Singular, since he can turn up more than once in a match, and ranked by how many times he
did it to you.

The icon is 🙇 — the bow, not the man. It is the gesture he performs rather than anything he feels,
which is why the recap says he is "sorry" in quotes and not that he is sorry.

### Icons

Every new emoji is clear of the other thirty-eight. The near-misses were 🗡️, 🐋 and 🐳, already held by
Coup de Grace, Captain Ahab and Wrong Whale — which is why the Dutchman took ⛵ for the sighting and
inherited 👻 from the deleted honor, rather than reaching for another ship or another whale.

Igon took 🏹 and 🐉: the bow for the man, the dragon for the thing he wanted dead. ⚡ would have been
the obvious pick for him getting up and is already Quickest Powder's, which is the whole reason the
storm in his marker is drawn rather than spelled.
