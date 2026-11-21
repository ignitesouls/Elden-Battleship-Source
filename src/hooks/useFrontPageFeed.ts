import { useSyncExternalStore } from "react";
import { fetchFrontPage, type FrontPageFeed } from "../lib/tournament/api";
import { isSupabaseConfigured } from "../lib/supabase";

/**
 * How often the front page is re-read: one front_page() request each time.
 *
 * The slowest-changing thing on it (events) would be happy with minutes; the fastest (a battle starting)
 * is still a match tens of minutes long, so a card appearing up to half a minute late costs nothing. At
 * 30s an open tab makes 120 requests an hour, against ~450 when the three sections polled separately.
 */
const POLL_MS = 30_000;

const EMPTY: FrontPageFeed = { live: [], events: [], scheduled: [] };

let feed: FrontPageFeed = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

/**
 * Reads the front page now. Concurrent calls share one request, so the sections mounting together - or a
 * section asking right after the poller did - never double up. A failed read keeps what is showing: the
 * front page must never fail over an extra, and a blip is not news.
 */
export function refreshFrontPage(): Promise<void> {
  if (!isSupabaseConfigured) return Promise.resolve();
  if (inflight) return inflight;
  inflight = fetchFrontPage()
    .then((next) => {
      feed = next;
      listeners.forEach((l) => l());
    })
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The poller's tick: nothing while the tab is hidden - nobody is looking, and that is how a budget leaks. */
function tick() {
  if (document.visibilityState === "visible") void refreshFrontPage();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // The first reader starts the one poller; the last one out stops it.
  if (listeners.size === 1 && isSupabaseConfigured) {
    tick();
    timer = setInterval(tick, POLL_MS);
    // A tab brought back to the front is current at once, not up to 30s behind.
    document.addEventListener("visibilitychange", tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", tick);
    }
  };
}

/**
 * The front page's live battles, event banners and scheduled official matches, from ONE polled
 * front_page() request shared by every section that reads it (Home, EventBanners, ScheduledMatches).
 *
 * Polled rather than subscribed: the front page is the screen people leave open, and a realtime channel
 * here would be held by every idle tab on the site.
 */
export function useFrontPageFeed(): FrontPageFeed {
  return useSyncExternalStore(subscribe, () => feed, () => EMPTY);
}
