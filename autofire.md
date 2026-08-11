# Elden Battleship — Auto-Fire Integration

## What it does

When a player kills a boss in Elden Ring, the square for that boss fires automatically on their
Battleship board. No alt-tabbing, no clicking.

This matters beyond convenience: under the fire-on-kill rule, a shot's timestamp is treated as the
kill time. Manual clicking bakes 1–3 seconds of reaction latency into every timing record and
leaderboard entry. Reading the kill from the game removes that.

## How it works

1. Player kills a boss. The game flips that boss's event flag, as it always does.
2. A DLL loaded into the game notices on its polling tick and sends a small JSON payload to a fixed
   HTTPS endpoint: who it is, and which flags are set.
3. The endpoint identifies the player from a token, then looks up which room they are currently in
   and which team they are on.
4. It maps the flag to a boss, then works out which square that boss occupies on that specific
   room's board.
5. It writes the shot — the identical database row a mouse click produces.
6. Every browser in the match updates through the live subscription the website already runs.

The DLL's entire job is *"this flag went true, and here's who I am."* Every piece of match-specific
knowledge lives server-side.

## The three pieces

**Game side.** A native DLL loaded by the mod loader. Polls boss-kill flags, reports what it sees.
Knows nothing about matches, teams, boards, or players.

**Endpoint.** A serverless function (Supabase Edge Function) with a permanent HTTPS URL. Receives
reports, resolves identity and board position, writes the shot. Nothing to host — no machine has to
stay online.

**Website.** Unchanged. Auto-fired shots are the same rows manual shots produce, so live updates,
archiving, statistics and replay all work as-is.

## Why the board doesn't need to be sent

Boards are never stored anywhere. A board is a pure function of the room id, the chosen square set,
and the match seed — every client runs the same deterministic shuffle and gets an identical layout.

The endpoint runs that same function to reconstruct the board and find the cell. So the DLL never
needs to know what the board looks like, and nothing has to be kept in sync.

## Identity: one permanent token

Rather than configuring match, team and slot, each player has a single token, generated on the
website and pasted into the DLL's config once. It encodes nothing.

Room, team and slot are resolved at the moment a kill lands, from data the website already holds
(a player's team is recorded when they join a room). Consequences:

- Configure once, ever. Switching teams, joining new rooms, or playing several matches back to back
  all work with no reconfiguration.
- The DLL has no concept of teams and therefore cannot get them wrong.
- A leaked token is bounded — it can fire shots in whatever room that player is in, nothing else.
  Regenerating invalidates it.

---

# The DLL

## Shape

A native DLL loaded as a `[[natives]]` entry in the me3 profile. No UI requirement; an overlay is
optional and purely cosmetic.

## Where it goes

Each native lives in its own folder alongside the me3 profile, with its config and logs beside it.
Battleship follows the same pattern:

```
Elden Casual Modes\
├─ EldenCluedo.exe
└─ Resources\
   └─ me3-v0.8.0\
      ├─ eldenring-basedlc.me3          ← profile, edited below
      ├─ launch-eldenring-basedlc.bat
      ├─ bin\
      ├─ Menu\                MenuInputDelayFix.dll
      ├─ StutterFix\          DINPUT8.DLL
      ├─ RandomizerHelper\    RandomizerHelper.dll + _config.ini
      └─ BattleshipAutoFire\            ← new
         ├─ battleship_autofire.dll
         ├─ battleship_autofire.toml
         └─ data\
            └─ engus\
               └─ bosses.json
```

Add one entry to `eldenring-basedlc.me3`:

```toml
[[natives]]
path = 'BattleshipAutoFire/battleship_autofire.dll'
```

Profile paths are relative to the `.me3` file's own directory — the same way `StutterFix/DINPUT8.DLL`
resolves today.

Two notes:

- **The config filename is the DLL's choice.** Existing natives don't agree on a convention
  (`RandomizerHelper_config.ini` vs `ignite_overlay_config.toml`), so whatever the DLL is coded to
  look for is what it gets called.
- **The `data\<language>\` subfolder travels with the DLL**, relative to its own location. If this
  reuses existing overlay code, that structure comes along with it.

**Nothing else in the install changes.** The randomizer is loaded as a `[[package]]`, which is a
separate mechanism from natives, and `EldenCluedo.exe` never rewrites the profile — a hand-added
native survives every reroll.

## Config — `battleship_autofire.toml`

```toml
[ingest]
url         = "https://<project>.supabase.co/functions/v1/auto-fire"
token       = "per-player, pasted once from the website"
interval_ms = 1000          # poll cadence; 1s is plenty
heartbeat_s = 60            # resend full state periodically as a safety net

[boss]
data_file = "bosses.json"   # existing format, unchanged

[overlay]
enabled = true              # one-line HUD, top right — see "Overlay" below
```

Three fields matter: `url`, `token`, and the boss data file. Everything else has a sane default.

## Data

No new data file is required. Watching the standard 207-entry boss list is fine — the server knows
which flags map to squares and ignores the rest. The DLL stays a general boss-flag watcher with no
Battleship-specific knowledge.

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
network blip, or a DLL restart mid-match all self-heal on the next send — no acknowledgements, no
sequence numbers, no replay buffer.

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

`tally` is the player's running score for the current match, computed server-side. It exists so the
overlay can hold no state of its own — see below. The DLL can ignore the body entirely if no overlay
is wanted.

## Overlay

Optional, and deliberately minimal — the Battleship board already shows what was marked, what hit
and what sank. Duplicating it in-game would create a second source of truth competing with the
authoritative one.

The overlay's job is not information, it's **reassurance**: you're mid-fight and can't check the
board, and you want to know the system is alive.

One line, top right:

```
Hit 8   Miss 4   Total 12   Acc 67%
```

Rendered straight from the last response's `tally` — the DLL stores nothing and computes nothing.

| State | Display |
|---|---|
| Working | `Hit 8   Miss 4   Total 12   Acc 67%` |
| Before the first shot | `Acc —` rather than `0%` — nothing has missed yet |
| Not in a match | hidden |
| Last send failed or was rejected | same line plus `⚠` |

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

Building only this — rather than a full boss checklist — also means no collapsible region tree, no
per-boss rows, no language files and no scrolling. One string in a corner, and far less surface
hooking the swapchain.

## Network behaviour

- HTTPS POST. **Connect, send, close** — no persistent connection. Serverless functions have a
  per-invocation wall-clock limit and matches run over an hour, so a held-open socket would be
  killed partway through.
- Worker thread. Never block the game thread.
- ~5s timeout.
- Retry with backoff (1s, 2s, 4s, cap 30s). On permanent failure do nothing special — the kill stays
  in the local set and rides along on the next successful send.

Volume is low: roughly 20–40 kills per player per match, about one every four minutes.

## Edge cases

**Save reload or quit to menu.** Flags revert to whatever the loaded save contains, so the observed
kill set can shrink. The DLL should never treat that as an un-kill. The server only ever adds;
removals are ignored, and nothing is un-fired.

**New character or different save.** The kill set changes wholesale. Server-side deduplication means
no damage, but a large jump is worth logging.

**Not in a match.** The DLL has no way to know. It just sends, and the server replies
`not_in_match`. Expected and harmless.

**Game not running or not in world.** Idle. Send nothing.

## Non-goals

- No match, team, or slot configuration
- No receiving or subscribing; it never needs pushed data
- No knowledge of boards, squares, rooms, or opponents
- No writing to game memory — strictly read-only

## Failure posture

Everything fails closed. If the DLL doesn't load, crashes, can't reach the network, or reads
nothing, the result is that no square auto-fires and the player clicks it themselves. Manual firing
is never removed, so the worst case is the status quo.

## Open questions

1. What does the existing publishing build currently send on the wire? Matching an existing payload
   shape is preferable to imposing a new one.
2. Full kill state per tick, or edge-triggered transitions? Full state is easier to make robust, but
   either can be accommodated.
3. Any concern about swapchain contention if an overlay is enabled, given the other natives loaded
   alongside it?
