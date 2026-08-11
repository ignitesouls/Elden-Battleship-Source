// Twitch sign-in without the email scope.
//
// Supabase's built-in Twitch provider hardcodes `user:read:email` server-side; passing an explicit
// `scopes` override to signInWithOAuth() changes nothing in the resulting authorize URL. The only
// way to stop asking players for their email address is to bypass the provider entirely: the client
// redirects to id.twitch.tv itself with an empty scope, and this function does the half of the
// exchange that needs the Client Secret.
//
// What it does NOT do is create a Supabase user. The caller already has one - an anonymous session
// carrying their fleet, their live room row and their career history - so the Twitch identity is
// written onto THAT user as metadata. Same uuid in, same uuid out.
//
// -- The returning-player problem --------------------------------------------------------------
// That "same uuid" guarantee only holds on the device where the player first signed in. On a second
// browser, or after a cache clear, `ensureSignedIn()` has already minted a *different* anonymous
// uuid, and this function is asked to attach an identity that a previous uuid already owns.
//
// The built-in provider solved this by signing you back in as the original user. We can't: that
// needs a session minted for an arbitrary uuid, and the only supported route (generateLink) requires
// an email address - which is precisely what we stopped collecting.
//
// So the durable identity is `profiles.twitch_id`, not the auth uuid, and the records follow the
// player to whichever uuid they're currently holding. `reclaim()` below moves them. The alternative
// - writing the same twitch_id under a second uuid - is not merely untidy: `profiles.twitch_id` is
// UNIQUE, so it fails outright with 23505, and if it didn't, the leaderboard would show the player
// twice and an admin grant pinned to their old uuid would stop resolving.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

interface TwitchMetadata {
  twitch_id: string
  twitch_login: string
  display_name: string
  avatar_url: string | null
}

/**
 * Moves a returning player's records from the uuid they used last time onto the one they're holding
 * now, then releases the old profile row so its UNIQUE twitch_id is free for the new one.
 *
 * Ordering is load-bearing: the old `profiles` row must be deleted before the new one is written,
 * or the upsert collides with the very constraint this is here to satisfy.
 *
 * Deliberately NOT migrated: `players.user_id`. Those rows are per-room and belong to whichever
 * session is actually sitting in the room - which is the caller's current uuid, already correct.
 * Rewriting the old uuid's rows would reach into a room on a device that may still be playing.
 */
async function reclaim(admin: SupabaseClient, oldId: string, newId: string): Promise<void> {
  // Career history. Both tables are keyed on the raw uuid with no foreign keys, by design - see
  // the profiles_and_career_stats migration - so a plain update is all that's needed.
  for (const table of ['match_participants', 'match_events'] as const) {
    const { error } = await admin.from(table).update({ user_id: newId }).eq('user_id', oldId)
    if (error) throw new Error(`Reassigning ${table} failed: ${error.message}`)
  }

  // Admin standing, including ownership. Without this, an admin who clears their cache silently
  // loses the panel and - for the owner tier, which is seeded from SQL and not grantable in-app -
  // there is no way to get it back from inside the site.
  const { data: oldAdmin } = await admin
    .from('admins')
    .select('display_name, is_owner, granted_by, granted_at')
    .eq('user_id', oldId)
    .maybeSingle()

  if (oldAdmin) {
    const { error: insertError } = await admin
      .from('admins')
      .upsert({ user_id: newId, ...oldAdmin }, { onConflict: 'user_id' })
    if (insertError) throw new Error(`Reassigning admin failed: ${insertError.message}`)
    await admin.from('admins').delete().eq('user_id', oldId)
  }

  const { error: profileError } = await admin.from('profiles').delete().eq('id', oldId)
  if (profileError) throw new Error(`Releasing old profile failed: ${profileError.message}`)

  // Leave the abandoned auth user without a Twitch claim, so a stale session on the other device
  // presents as signed-out rather than as a second holder of the same Twitch account.
  await admin.auth.admin.updateUserById(oldId, {
    user_metadata: { twitch_id: null, twitch_login: null, display_name: null, avatar_url: null },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { code, redirectUri } = await req.json()
    if (!code || !redirectUri) return jsonResponse({ error: 'Missing code or redirectUri' }, 400)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return jsonResponse({ error: 'Not signed in' }, 401)

    // The caller's own token, used only to establish who they are. Everything that writes runs
    // through the service-role client below.
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )
    const {
      data: { user: caller },
      error: callerError,
    } = await callerClient.auth.getUser()
    if (callerError || !caller) return jsonResponse({ error: 'Invalid session' }, 401)

    const clientId = Deno.env.get('TWITCH_CLIENT_ID')!
    const clientSecret = Deno.env.get('TWITCH_CLIENT_SECRET')!

    // redirect_uri is not where Twitch sends anyone at this point - the redirect already happened.
    // It is replayed purely so Twitch can check it matches the one the code was issued against.
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    })
    if (!tokenRes.ok) {
      return jsonResponse({ error: 'Twitch token exchange failed', detail: await tokenRes.text() }, 400)
    }
    const { access_token: accessToken } = await tokenRes.json()

    // /helix/users with no `id` or `login` filter returns the token owner, and needs no scope
    // beyond a valid token - which is what makes the empty-scope authorize request sufficient.
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId },
    })
    if (!userRes.ok) {
      return jsonResponse({ error: 'Twitch user lookup failed', detail: await userRes.text() }, 400)
    }
    const { data } = await userRes.json()
    const twitchUser = data?.[0]
    if (!twitchUser) return jsonResponse({ error: 'No Twitch user returned' }, 400)

    const metadata: TwitchMetadata = {
      twitch_id: twitchUser.id,
      twitch_login: twitchUser.login,
      display_name: twitchUser.display_name,
      avatar_url: twitchUser.profile_image_url ?? null,
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Has this Twitch account been here before under a different uuid?
    const { data: existing, error: lookupError } = await admin
      .from('profiles')
      .select('id, nickname')
      .eq('twitch_id', metadata.twitch_id)
      .maybeSingle()
    if (lookupError) throw new Error(`Profile lookup failed: ${lookupError.message}`)

    let reclaimed = false
    // Read off the old row before reclaim() deletes it. The nickname is the player's own choice of
    // name, so losing it on a second device would look exactly like the reset this column was added
    // to stop - and unlike display_name, Twitch cannot tell us what it was.
    let carriedNickname: string | null = null
    if (existing && existing.id !== caller.id) {
      carriedNickname = existing.nickname ?? null
      await reclaim(admin, existing.id, caller.id)
      reclaimed = true
    }

    const { error: updateError } = await admin.auth.admin.updateUserById(caller.id, {
      user_metadata: metadata,
    })
    if (updateError) throw updateError

    const { error: profileError } = await admin.from('profiles').upsert(
      {
        id: caller.id,
        twitch_id: metadata.twitch_id,
        display_name: metadata.display_name,
        avatar_url: metadata.avatar_url,
        // Only written when there is one to carry across a reclaim. Omitting it keeps the column
        // out of the ON CONFLICT SET list, so an ordinary re-login leaves the nickname already on
        // the row alone instead of nulling it.
        ...(carriedNickname ? { nickname: carriedNickname } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    )
    if (profileError) throw profileError

    return jsonResponse({ ok: true, reclaimed, ...metadata })
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500)
  }
})
