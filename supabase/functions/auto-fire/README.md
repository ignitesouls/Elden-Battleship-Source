# Auto-fire ingest

Fires a player's shot when the game reports they killed the boss on that square.

The caller is a native mod loaded into Elden Ring. It sends a token and the boss event flags it can
currently see set; everything else — which player, which room, which team, which cell — is resolved
here from state the website already holds.

## Deploy

```bash
supabase functions deploy auto-fire --no-verify-jwt --project-ref zltjdeikpsbohvgtmmsn
```

**`--no-verify-jwt` is required.** Unlike `twitch-login`, this caller has no Supabase session and no
bearer token to send. With verification on, the gateway rejects the request before the function runs.
`supabase/config.toml` declares the same thing under `[functions.auto-fire]` for local serving.

That makes the endpoint publicly reachable. Authentication is the ingest token in the request body,
checked against `ingest_tokens`. Without a valid token nothing happens, and a valid token can only
fire shots in whatever room its owner is currently playing a match in.

Requires `supabase/migrations/20260812000000_ingest_tokens.sql` to have been applied.

## Request

```json
{
  "token": "48 hex characters from the player's profile page",
  "kills": [
    { "flag": 1042360800, "at": "2026-08-12T19:04:12.140Z" }
  ]
}
```

`kills` should carry the client's **full current kill set**, not just the newest transition. The
function diffs against what has already been fired, which is what lets a dropped request, a network
blip or the mod restarting mid-match all heal on the next send with no acknowledgement protocol.

`at` is optional and clamped to five seconds around arrival. It exists so a recorded kill time isn't
inflated by poll and network latency; the clamp exists because every timing record derives from that
column and an unclamped client timestamp would be a backdating tool.

## Response

```json
{
  "ok": true,
  "fired":   [ { "flag": 1042360800, "cell": 37, "result": "hit" } ],
  "skipped": [ { "flag": 31150800, "reason": "already_fired" } ],
  "tally":   { "hits": 8, "misses": 4, "shots": 12, "accuracy": 67 }
}
```

`tally` is the player's running score for the current match, in the website's own terms: one shot
counts once however many boards it landed on, and counts as a hit if it connected with any of them.
It is computed here rather than tallied by the client for three reasons: manually-clicked squares
are counted, the client has no match boundary to detect, and the overlay can never disagree with the
scoreboard. `accuracy` is null before the first shot.

Skip reasons: `not_a_square` (the mod watches every boss; only some are squares), `not_on_this_board`,
`already_fired`, `no_opponents`, `insert_failed`.

## Refusals

| `error` | Meaning |
|---|---|
| `missing_token` / `unknown_token` | No token, or one that resolves to nobody |
| `not_in_match` | Token is valid but its owner isn't in a room that's in battle. Normal, and the common case |
| `ambiguous_match` | Owner is in two live matches. Refuses rather than guessing which board to shoot |
| `unsupported_square_set` | Room isn't playing `bosses`. The objective sets are counters and judgement calls no event flag can settle |

## Testing without the mod

```bash
node --experimental-strip-types scripts/check-auto-fire.ts
```

Creates a throwaway room, fires a real shot through the real path, checks the cell, the rows, the
resolution, the clamp, the replay behaviour and every refusal, then deletes the room. Pass a URL as
the first argument to test against `supabase functions serve` instead of the deployed function.
