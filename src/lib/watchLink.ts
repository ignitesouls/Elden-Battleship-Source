/**
 * The watch link's ADDRESS, on its own.
 *
 * -- Why this is its own module ------------------------------------------------------------------
 *
 * ./watchStream owns the RPCs, so it imports the supabase client, and nothing that imports it can be
 * run outside a browser. That is fine for the four functions that talk to the database and useless
 * for the part of this feature that most wants asserting: what ends up in the URL a streamer pastes
 * into a public Twitch panel.
 *
 * Getting that wrong fails silently and in the worst possible direction. This link is broadcast to
 * strangers by design, so the day somebody "helpfully" appends a token to it - to save a round trip,
 * to carry a preference, to identify the viewer - is the day a streamer publishes a credential to
 * their whole audience and nothing anywhere says so. Same reasoning, and the same split, as
 * lib/streamSources sitting apart from lib/streamOverlay. See scripts/check-watch-link.ts, which is
 * only able to exist because of this.
 */

/** Where the watch page lives, as one definition rather than a string spelled out in three places. */
export const WATCH_ROUTE = "watch";

/**
 * A handle as it belongs in a URL.
 *
 * Twitch hands logins out lowercase, so this is mostly about the human end: somebody typing a link
 * they heard on stream, or a streamer copying their own name out of Twitch's UI where it is shown
 * capitalised. The lookup lowercases too (see watch_session), so the two agree.
 */
export function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

/**
 * The link a streamer gives their audience.
 *
 * Built off a caller-supplied base rather than a constant, so it stays correct on localhost, on
 * GitHub Pages under its /Elden-Battleship/ base, and anywhere else this is hosted - hardcoding the
 * deployed origin would hand every local tester a link pointing at production.
 *
 * There is no query string and there must never be one. The whole argument for this being a name
 * rather than a random string is that it carries nothing worth protecting; a parameter is how that
 * stops being true. Anything a viewer needs is resolved server-side from the handle.
 *
 * The handle is percent-encoded even though a real Twitch login never needs it: this function is
 * also handed whatever a caller has in a text field, and a slash in there would otherwise invent a
 * route segment.
 */
export function watchUrl(base: string, handle: string): string {
  return `${base}#/${WATCH_ROUTE}/${encodeURIComponent(normalizeHandle(handle))}`;
}
