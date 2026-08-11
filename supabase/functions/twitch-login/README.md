# Twitch login without the email scope

Supabase's built-in Twitch provider appends `user:read:email` to the authorize request server-side.
No client option removes it. passing an explicit empty `scopes` to `signInWithOAuth()` leaves the
resulting `scope` parameter unchanged. So players were required to grant email access to play a
browser game. This function replaces that provider.

The browser now redirects to `id.twitch.tv/oauth2/authorize` itself with `scope=` empty, and this
function performs the half of the exchange that needs the Client Secret.

## Deploy

```bash

supabase functions deploy twitch-login --project-ref zltjdeikpsbohvgtmmsn
```

Or paste `index.ts` into Supabase Dashboard > Edge Functions > new function named `twitch-login`.

Leave JWT verification on (the default). The function identifies the caller from their bearer token
and refuses the request without one.

## Configure

**1. Twitch Developer Console** (dev.twitch.tv/console, the app Battleship already uses)
> OAuth Redirect URLs. Add both:

```
https://kcbrazos.github.io/Elden-Battleship/
http://localhost:5173/Elden-Battleship/
```

The trailing slash matters. it must byte-match `origin + pathname`, and Vite's `base` puts
`/Elden-Battleship/` in the path in dev as well as production.

**2. Supabase > Edge Functions > Secrets.** Add `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`,
reusing the existing Twitch app's values. Regenerating the secret invalidates it everywhere it is
currently used. (`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically. do not add them by hand.)

**3. `.env.local`.** Set `VITE_TWITCH_CLIENT_ID` to the same Client ID and rebuild. This is
public by design and appears in every authorize URL; the *secret* must never go in a `VITE_` var.
Until it is set the login button renders disabled.

**4. Anonymous sign-ins** must stay enabled (Authentication > Sign In / Providers). Already on -
`config.toml` has `enable_anonymous_sign_ins = true`, and the whole flow attaches to an anonymous
session rather than creating a user.

**5. Only after a real end-to-end login succeeds**, turn the built-in Twitch provider off
(Authentication > Sign In / Providers > Twitch). Anyone linked through the old flow keeps their
records but shows as signed out until they click login once more.

## Why it reassigns records

`admin.updateUserById` writes the Twitch identity onto the caller's *existing* uuid, so the fleet and
room membership already tied to that anonymous session carry over untouched. That works perfectly on
the device where the player first signs in.

It does not survive a second device. There, `ensureSignedIn()` has already minted a different
anonymous uuid, and the identity being attached belongs to an earlier one. The built-in provider
handled this by signing you back in as the original user; that is not reproducible here, because
minting a session for an arbitrary uuid requires `generateLink`, which requires an email address -
the thing we just stopped collecting.

So the durable identity is `profiles.twitch_id`, and `reclaim()` moves the player's records onto
whichever uuid they currently hold: `match_participants.user_id`, `match_events.user_id`, their
`admins` row (including the owner tier, which is seeded from SQL and cannot be regranted in-app), and
the `profiles` row itself. Writing the same `twitch_id` under a second uuid instead is not an option:
the column is `unique`, so it fails with `23505`.

`players.user_id` is deliberately left alone. those rows are per-room and belong to the session
actually sitting in the room, which is already the caller.

`profiles.nickname`. the name a player chose for themselves. is read off the old row *before*
`reclaim()` deletes it and written into the new one. Twitch cannot tell us what it was, so without
that carry, signing in on a second device would silently revert them to their Twitch display name.
On an ordinary re-login the column is omitted from the upsert entirely, which keeps it out of the
`ON CONFLICT ... SET` list so the existing nickname survives.

One consequence worth knowing: a player's uuid is no longer stable across devices, so an old
`#/player/<uuid>` link stops resolving after they sign in somewhere new. The stats themselves follow
them.

## Verifying

The response body reports which path ran:

```json
{ "ok": true, "reclaimed": false, "twitch_id": "...", "display_name": "..." }
```

`reclaimed: true` means records were moved from a previous uuid. To exercise it, sign in, then sign
in again from a private window and confirm the leaderboard still shows one entry with the full
career rather than two partial ones.

`node scripts/test-nickname.mjs` covers the nickname half against the live database:
that a player can rename themselves with the anon key, that a stranger holding the same key cannot,
and that the name survives both a reclaim and an ordinary re-login.
