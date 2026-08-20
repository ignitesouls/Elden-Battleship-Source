# Elden Battleship — Auto-Fire Integration

> **Status: shipped.** This began life as a proposal for a DLL nobody had written yet. It is now a
> record of what exists. The game side ships inside **Dionysus** as the Ignite overlay
> (`er_overlay.dll`); the server side is the `auto-fire` edge function in this repo. Where the two
> disagree, the code wins and this file is wrong.

## What it does

When a player kills a boss in Elden Ring, the square for that boss fires automatically on their
Battleship board. No alt-tabbing, no clicking.

This matters beyond convenience: under the fire-on-kill rule, a shot's timestamp is treated as the
kill time. Manual clicking bakes 1-3 seconds of reaction latency into every timing record and
leaderboard entry. Reading the kill from the game removes that.

## How it works

1. Player kills a boss. The game flips that boss's event flag, as it always does.
2. The overlay DLL notices on its polling tick and sends a small JSON payload to a fixed HTTPS
   endpoint: who it is, and which flags are set.
3. The endpoint identifies the player from a token, then looks up which room they are currently in
   and which team they are on.
4. It maps the flag to a boss, then works out which square that boss occupies on that specific
   room's board.
5. It writes the shot: the identical database row a mouse click produces.
6. Every browser in the match updates through the live subscription the website already runs.

The DLL's entire job is *"this flag went true, and here's who I am."* Every piece of match-specific
knowledge lives server-side.

## The three pieces

**Game side.** A native DLL loaded by me3 from inside Dionysus. Polls boss-kill flags, reports what
it sees. Knows nothing about matches, teams, boards, or players.

**Endpoint.** `supabase/functions/auto-fire/index.ts`, a Supabase Edge Function with a permanent
HTTPS URL. Receives reports, resolves identity and board position, writes the shot. Nothing to host,
no machine has to stay online.

**Website.** Unchanged. Auto-fired shots are the same rows manual shots produce, so live updates,
archiving, statistics and replay all work as-is. Its only contribution is minting the token, on the
profile page.

## Why the board doesn't need to be sent

Boards are never stored anywhere. A board is a pure function of the room id, the chosen square set,
and the match seed. Every client runs the same deterministic shuffle and gets an identical layout.

The endpoint runs that same function to reconstruct the board and find the cell, which is why it
imports `seededRandom`, `squareSetFormat` and `boardBalance` from `src/lib` rather than
reimplementing them. So the DLL never needs to know what the board looks like, and nothing has to be
kept in sync.

The balancer's permutation is the sharp edge here. A balanced board deals the same squares to
different cells, so a kill resolved without applying `applyBoardPerm` would fire at the cell that
boss *used* to be on: a real shot, on the wrong square, with no undo. See the comment on
`boardIndex()`.

## Identity: one permanent token

Rather than configuring match, team and slot, each player has a single token, generated on the
website and pasted into the config once. It encodes nothing.

Room, team and slot are resolved at the moment a kill lands, from data the website already holds
(a player's team is recorded when they join a room). Consequences:

- Configure once, ever. Switching teams, joining new rooms, or playing several matches back to back
  all work with no reconfiguration.
- The DLL has no concept of teams and therefore cannot get them wrong.
- A leaked token is bounded. It can fire shots in whatever room that player is in, nothing else.
  Regenerating invalidates it.

---

# The game side

## Where it lives in Dionysus

The overlay ships installed. Nothing is added by hand any more, and the old instructions for
creating a native folder and editing the me3 profile are gone from the site along with the need for
them.

```
Dionysus\
├─ Dionysus.exe
└─ Resources\
   └─ me3-v0.8.0\
      ├─ eldenring-basedlc.me3
      ├─ launch-eldenring-basedlc.bat
      ├─ bin\
      ├─ Menu\                MenuInputDelayFix.dll
      ├─ StutterFix\          DINPUT8.DLL
      ├─ RandomizerHelper\    RandomizerHelper.dll + _config.ini
      └─ EROverlay\
         ├─ er_overlay.dll
         ├─ overlay_config.toml        ← the only file a player touches
         └─ data\
            └─ engus\
               └─ bosses.json
```

Rerolling does not disturb it. The randomizer loads as a `[[package]]`, a separate mechanism from
natives, and the launcher never rewrites the profile.

## Config — `overlay_config.toml`

The filename is compiled into the DLL, which looks only in its own folder. Rename it and the mod
loads with no configuration at all.

```toml
[ingest]
# An empty token disables all networking.
# Changes to timing settings require a restart.
url = "https://<project>.supabase.co/functions/v1/auto-fire"
token = "per-player, pasted once from the website"
interval_ms = 1000
heartbeat_s = 60

[overlay]
show_ingest_tally = true      # the one-line HUD, see "Overlay" below

[boss]
data_file = "bosses.json"     # existing format, unchanged
```

The file carries a lot more than this (`[common]`, `[input]`, `[style]`, `[timer]`), all of it the
overlay's own business and none of it Battleship's.

**How a player fills it in.** The profile page hands over the entire file with `url` and `token`
already filled, and the guide is four steps: get current Dionysus, open the file, `Ctrl+A` `Ctrl+V`,
`Ctrl+S`. Whole file rather than the `[ingest]` table alone, because "replace exactly this section
and don't leave the old one behind" is several instructions, and getting any of them wrong produces
a config TOML refuses to parse. The template lives in `src/lib/overlayConfig.ts` and is a verbatim copy of the
stock config, which means **it has to be re-copied whenever the mod's default config changes** or
pasting it will quietly revert people to old defaults.

## Data

No new data file is required. Watching the standard boss list is fine: the server knows which flags
map to squares and ignores the rest. The DLL stays a general boss-flag watcher with no Battleship
knowledge. `src/data/bossFlags.json` currently maps 206 flags, one per square on the full boss set.

## The loop

1. On load, wait until the player is in-world before touching flag memory. Reading flag/param data
   during boot can crash the game; `IGT > 0` is a reliable "subsystems are up" signal.
2. Read the current state of every flag in the list.
3. Diff against the previous snapshot. Record a local timestamp the first time each flag is seen
   true.
4. If anything transitioned to true, or the heartbeat is due, send.
5. Sleep, repeat.

## Payload

Full current kill set on every send, with per-flag first-observed timestamps:

```json
{
  "token": "…",
  "kills": [
    { "flag": 1042360800, "at": "2026-08-11T19:04:12.140Z" },
    { "flag": 31150800,   "at": "2026-08-11T18:41:03.020Z" }
  ]
}
```

Sending full state rather than individual events is what makes this robust. A dropped request, a
network blip, or a DLL restart mid-match all self-heal on the next send. No acknowledgements, no
sequence numbers, no replay buffer.

`at` is honoured, because under fire-on-kill the shot timestamp *is* the kill time and taking it
from arrival would bake the poll interval and a round trip into every record. It is clamped to
`MAX_BACKDATE_MS` (5s) before now: more than a 1s poll plus a round trip needs, and less than any
margin worth cheating for.

## Response

```json
{
  "ok": true,
  "fired":   [ { "flag": 1042360800, "cell": 37, "result": "hit" } ],
  "skipped": [ { "flag": 31150800, "reason": "already_fired" } ],
  "tally":   { "hits": 8, "misses": 4, "shots": 12, "accuracy": 67 }
}
```

Or on rejection:

```json
{ "ok": false, "error": "not_in_match" }
```

`accuracy` is `null`, not `0`, before the first shot. Nothing has missed yet, and the overlay shows a
dash.

### Rejections

| `error` | HTTP | Meaning |
|---|---|---|
| `method_not_allowed` | 405 | Not a POST |
| `missing_token` | 400 | No token in the body |
| `unknown_token` | 403 | Token does not resolve to a player. Mistyped, or replaced since it was pasted |
| `not_in_match` | 200 | Player is in no room that is in battle. The normal idle state |
| `ambiguous_match` | 409 | Player is seated in more than one live match. Nothing fires in either, because a shot cannot be taken back |
| `unsupported_square_set` | 200 | The room's board is an objectives set |
| `internal` | 500 | Carries a `detail` string |

### Skip reasons

Per flag, inside a successful response. None of these are errors.

| `reason` | Meaning |
|---|---|
| `not_a_square` | A boss that is not in the square set at all |
| `not_on_this_board` | In the set, but not dealt to this room |
| `already_fired` | Including a square the player clicked manually first |
| `no_opponents` | Nobody to shoot at |
| `insert_failed` | The write lost a race. Rides along on the next send |

## Overlay

Optional, and deliberately minimal. The Battleship board already shows what was marked, what hit and
what sank. Duplicating it in-game would create a second source of truth competing with the real
one.

The overlay is there for **reassurance** rather than information: you're mid-fight, you can't check
the board, and you want to know the system is alive.

One line:

```
Hit 8   Miss 4   Total 12   Acc 67%
```

Rendered straight from the last response's `tally`. The DLL stores nothing and computes nothing.

| State | Display |
|---|---|
| Connected, match live, no shots yet | `Hit 0   Miss 0   Total 0   Acc -` |
| Working | `Hit 8   Miss 4   Total 12   Acc 67%` |
| Not in a match, or an objectives board | hidden |
| `unknown_token` / `missing_token` | `Autofire [!] bad token` |
| `ambiguous_match` | `Autofire [!] in 2 live matches` |
| Cannot reach the endpoint | `Autofire [!] no connection` |
| Accepted, but the reply carried no tally | `Autofire connected` |

`[!]` always means the last report did not land. Expanding the overlay (`=` by default) shows the
raw error code, which is the thing to ask for in a bug report.

The warning glyph is the important part. Without it a stale tally looks identical to a live one, and
a player would have no way to tell that their last kill never landed.

**Why the server supplies the numbers rather than the DLL counting them:**

- **Manually-clicked squares are included.** A local tally would only count the DLL's own confirmed
  sends, so anyone who clicked a few squares by hand would see a total lower than their real score.
- **No reset logic.** The DLL has no idea when a match starts or ends. Server-supplied totals simply
  change when the match does.
- **They cannot disagree with the site.** Same source, so the overlay and the scoreboard always
  match. A visible discrepancy would make players distrust the overlay, which defeats its purpose.

Definitions match the website exactly: one shot counts once, scored a hit if it connected with *any*
opponent (a single shot lands on every opposing board at once), and `accuracy = round(hits / shots
× 100)`.

## Network behaviour

- HTTPS POST. **Connect, send, close.** No persistent connection: serverless functions have a
  per-invocation wall-clock limit and matches run over an hour, so a held-open socket would be
  killed partway through.
- Worker thread. Never block the game thread.
- ~5s timeout.
- Retry with backoff (1s, 2s, 4s, cap 30s). On permanent failure do nothing special. The kill stays
  in the local set and rides along on the next successful send.

Volume is low: roughly 20-40 kills per player per match, about one every four minutes.

## Edge cases

**Save reload or quit to menu.** Flags revert to whatever the loaded save contains, so the observed
kill set can shrink. The DLL never treats that as an un-kill. The server only ever adds; removals are
ignored, and nothing is un-fired.

**New character or different save.** The kill set changes wholesale. Server-side deduplication means
no damage.

**A save that already has kills on it.** Every one of those flags is set the moment the mod loads,
so any of them that are squares on the current board fire immediately. This looks like a bug and is
not one. A fresh character is the only way to get a clean run.

**Language.** Reports carry flag ids, never names, and every localized boss list holds the same
flags. `language` changes what the boss list reads like and nothing else.

**Not in a match.** The DLL has no way to know. It just sends, and the server replies
`not_in_match`. Expected and harmless.

**Game not running or not in world.** Idle. Send nothing.

## Non-goals

- No match, team, or slot configuration
- No receiving or subscribing; it never needs pushed data
- No knowledge of boards, squares, rooms, or opponents
- No writing to game memory: strictly read-only

## Failure posture

Everything fails closed. If the DLL doesn't load, crashes, can't reach the network, or reads
nothing, the result is that no square auto-fires and the player clicks it themselves. Manual firing
is never removed, so the worst case is the status quo.

## What the server refuses

Worth stating separately from failure posture, because these are deliberate and permanent:

- **Boss boards only,** either cut of them. The objectives sets are counters and judgement calls
  ("collect 4 unique helms") that no event flag can settle. A stale client left running must not be
  able to fire into one.
- **Rooms in battle only.** Sitting in a lobby with a board on screen is not enough.
- **Exactly one live match.** Two would mean guessing which board to shoot at.
