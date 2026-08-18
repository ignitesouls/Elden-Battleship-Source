import { createClient, type User } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

if (!isSupabaseConfigured) {
  // eslint-disable-next-line no-console
  console.error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill in your Supabase project's values."
  );
}

const twitchClientId = import.meta.env.VITE_TWITCH_CLIENT_ID as string | undefined;

/** Twitch login needs its own Client ID on top of the Supabase pair. Public by design - not the secret. */
export const isTwitchLoginConfigured = Boolean(isSupabaseConfigured && twitchClientId);

const TWITCH_STATE_KEY = "twitch_oauth_state";

/**
 * Lifts a Twitch OAuth callback off the URL, before anything else looks at it.
 *
 * Ordering is the entire point of doing this at module scope rather than in a component. The client
 * below runs the PKCE flow with detectSessionInUrl, so supabase-js inspects `?code=` on startup and
 * would try to redeem OUR Twitch code against Supabase's token endpoint. It only does that when it
 * also finds a code verifier in storage, which we never write - but a verifier abandoned by an
 * earlier, interrupted Supabase OAuth attempt would still be sitting there, and then the two flows
 * fight over the same parameter. Removing the params before createClient() is called settles it.
 *
 * `state` is the discriminator, not merely a CSRF check: a `code` we did not issue a state for is
 * somebody else's and is left on the URL untouched.
 */
function captureTwitchCallback(): { code: string; redirectUri: string } | null {
  if (typeof window === "undefined") return null;

  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return null;

  let expected: string | null = null;
  try {
    expected = sessionStorage.getItem(TWITCH_STATE_KEY);
  } catch {
    // Private-mode storage. Nothing to verify against, so treat the code as not ours.
  }
  if (!expected || expected !== state) return null;

  try {
    sessionStorage.removeItem(TWITCH_STATE_KEY);
  } catch {
    // Already unavailable; the state has served its purpose either way.
  }

  // Read before rewriting: this must byte-match the redirect_uri sent to /authorize or Twitch
  // rejects the exchange.
  const redirectUri = `${window.location.origin}${window.location.pathname}`;

  // Strip the callback so a reload doesn't re-submit a code Twitch has already burned. The hash is
  // preserved because HashRouter keeps the current route in it.
  params.delete("code");
  params.delete("state");
  params.delete("scope");
  const query = params.toString();
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
  );

  return { code, redirectUri };
}

const pendingTwitchCallback = captureTwitchCallback();

// createClient throws on an invalid URL, which would otherwise crash the whole app before
// it can render the "not configured yet" message below. Fall back to a syntactically valid
// placeholder so the client can exist but simply fail requests until real values are set.
export const supabase = createClient(url || "https://placeholder.supabase.co", anonKey || "placeholder-anon-key", {
  realtime: {
    /**
     * Run realtime's keepalive in a Web Worker so a hidden tab keeps its connection.
     *
     * The heartbeat interval is 25s, and by default it's an ordinary setInterval on the main
     * thread - which browsers throttle to roughly once a minute in a background tab, i.e. past
     * the point the server gives up on us. The socket then dies and reconnects on a loop for as
     * long as the tab stays hidden. A worker's timers aren't throttled, so the heartbeat keeps
     * its real cadence.
     *
     * This is the half of the problem that hurts the views meant to be watched while nobody is
     * clicking on them: the caster screen and the OBS overlays. Players get the other half from
     * the visibility re-read in useRoom.
     *
     * Guarded because realtime-js throws outright when asked for a worker in a browser that has
     * none, and this runs at module scope - an unguarded throw here takes the whole site down
     * rather than degrading one feature.
     */
    worker: typeof Worker !== "undefined",
  },
  auth: {
    // PKCE, not implicit. The implicit flow returns tokens in the URL *fragment*, which would
    // collide head-on with HashRouter's `#/room/...` routing; PKCE comes back as a `?code=`
    // query param instead and is exchanged before routing ever looks at the hash.
    flowType: "pkce",
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
  },
});

let signInPromise: Promise<string> | null = null;

/** Ensures a session exists (anonymous unless the player signed in with Twitch) and returns the user id. */
export function ensureSignedIn(): Promise<string> {
  if (!signInPromise) {
    signInPromise = (async () => {
      const { data: existing } = await supabase.auth.getSession();
      if (existing.session?.user?.id) {
        return existing.session.user.id;
      }
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error || !data.user) {
        throw error ?? new Error("Anonymous sign-in failed");
      }
      return data.user.id;
    })();
  }
  return signInPromise;
}

/** Drops the memoised sign-in so the next ensureSignedIn() re-reads the (possibly new) session. */
export function resetSignInCache(): void {
  signInPromise = null;
}

export interface TwitchProfile {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isTwitch: boolean;
  twitchId: string | null;
}

/**
 * Reads Twitch identity details off the current session, if the player signed in.
 *
 * Since the switch away from Supabase's built-in provider there is no Twitch entry in
 * `user.identities` to read - the edge function writes the identity to user_metadata instead. The
 * identities check is kept as a fallback so anyone still holding a session from the old flow stays
 * recognized until their next sign-in, rather than being shown as anonymous with their stats
 * apparently gone.
 */
export function profileFromUser(user: User | null): TwitchProfile | null {
  if (!user) return null;
  const meta = user.user_metadata ?? {};
  const twitchId = (meta.twitch_id as string) ?? null;
  const legacyIdentity = (user.identities ?? []).find((i) => i.provider === "twitch");
  return {
    userId: user.id,
    displayName:
      (meta.display_name as string) ??
      (meta.nickname as string) ??
      (meta.name as string) ??
      (meta.full_name as string) ??
      null,
    avatarUrl: (meta.avatar_url as string) ?? (meta.picture as string) ?? null,
    isTwitch: Boolean(twitchId || legacyIdentity),
    twitchId: twitchId ?? legacyIdentity?.id ?? null,
  };
}

/**
 * Where Twitch sends the player back to. Must be listed verbatim in the Twitch Developer Console's
 * OAuth Redirect URLs - it is no longer Supabase's redirect allowlist that governs this.
 *
 * Query and hash are dropped so the callback's `?code=` lands on a clean URL, and because the token
 * exchange replays this value for Twitch to compare against: it has to be reproducible on return,
 * when HashRouter will have put a route in the fragment.
 */
function redirectTarget(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

/**
 * Signs in with Twitch, asking for no permissions at all.
 *
 * This deliberately does not use supabase.auth.signInWithOAuth()/linkIdentity(). Supabase's built-in
 * Twitch provider appends `user:read:email` server-side and there is no client option that removes
 * it, so every player was made to hand over their email address to play a browser game. Redirecting
 * to Twitch ourselves with `scope=` empty is the only way to stop asking; the half of the exchange
 * that needs the Client Secret happens in the `twitch-login` edge function.
 *
 * The anonymous session is established BEFORE leaving the page, so the identity lands on the user
 * that already owns this browser's fleet rather than on one minted after the round trip.
 */
export async function signInWithTwitch(): Promise<void> {
  if (!twitchClientId) {
    throw new Error("Missing VITE_TWITCH_CLIENT_ID - Twitch login is not configured for this build.");
  }
  await ensureSignedIn();

  const state = crypto.randomUUID();
  sessionStorage.setItem(TWITCH_STATE_KEY, state);

  const authorize = new URL("https://id.twitch.tv/oauth2/authorize");
  authorize.searchParams.set("client_id", twitchClientId);
  authorize.searchParams.set("redirect_uri", redirectTarget());
  authorize.searchParams.set("response_type", "code");
  // Empty, not omitted. This is the whole reason the built-in provider had to go.
  authorize.searchParams.set("scope", "");
  authorize.searchParams.set("state", state);

  window.location.assign(authorize.toString());
}

let twitchLoginPromise: Promise<User | null> | null = null;

/**
 * Finishes a Twitch sign-in if the page was just redirected back from one.
 *
 * Resolves to null on every normal page load, so it is safe (and cheap) to await unconditionally.
 * Memoised because an authorization code is single-use: a second exchange would fail, and React's
 * StrictMode double-invokes effects in development.
 *
 * Failures are reported and swallowed. A player who cannot complete a Twitch login should still get
 * the site, anonymously, rather than a blank screen.
 */
export function completeTwitchLogin(): Promise<User | null> {
  if (!twitchLoginPromise) {
    twitchLoginPromise = (async () => {
      if (!pendingTwitchCallback) return null;
      // The function attaches the identity to whoever the bearer token says we are, so there has to
      // be a session on the request.
      await ensureSignedIn();

      const { error } = await supabase.functions.invoke("twitch-login", {
        body: pendingTwitchCallback,
      });
      if (error) {
        // eslint-disable-next-line no-console
        console.error("Twitch login failed", error);
        return null;
      }

      // The identity was written server-side, so the session sitting in storage still holds the user
      // object it was created with: an anonymous user with empty metadata.
      //
      // getUser() is NOT enough here. It fetches the updated record over the network and returns it,
      // which makes the UI correct - but auth-js's _getUser never calls _saveSession, so nothing is
      // written back. The next reload reads the stale stored session, finds no twitch_id, and shows
      // the player as signed out until the access token happens to expire.
      //
      // refreshSession() mints a new session from the refresh token and persists it, so the identity
      // survives a refresh. See scripts/repro-stale-session.mjs.
      resetSignInCache();
      const { data, error: refreshError } = await supabase.auth.refreshSession();
      if (refreshError) {
        // Degrade to the in-memory-only result rather than dropping the sign-in entirely: correct
        // until the next reload, which is strictly better than looking signed out immediately.
        // eslint-disable-next-line no-console
        console.error("Twitch login: session refresh failed", refreshError);
        const { data: fallback } = await supabase.auth.getUser();
        return fallback.user ?? null;
      }
      return data.user ?? null;
    })();
  }
  return twitchLoginPromise;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
  resetSignInCache();
}
