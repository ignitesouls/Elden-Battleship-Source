/**
 * What the front page says about tournaments, decided in one place.
 *
 * Nothing tournament-shaped appears for a visitor until an administrator opens an event for signup, and
 * each event that is visible gets its own banner - events are independent and any number can be on the
 * page at once.
 *
 *   draft       nothing. (The database hides drafts from non-admins in the first place.)
 *   signup      "Sign up" while signup is open; "signup closed, starting soon" once it has closed but an
 *               administrator hasn't started the event yet, so the button is never offered for a signup
 *               the database would refuse.
 *   live        "View the bracket".
 *   finished    congratulate the winners for two weeks, then it leaves the front page (the event's own
 *               page stays).
 *   cancelled   nothing. A cancelled event is gone from the front page; only its own page remains.
 */

import type { Language } from "../language";

export const CHAMPION_BANNER_DAYS = 14;

/**
 * An event's name as it should be printed: trimmed, with any run of spaces, tabs or line breaks
 * collapsed to one space. The database already stores names this way (see the tournament-name trigger
 * in the visibility migration); doing it here as well means a name that arrives some other way - the
 * SQL editor, an import - still cannot put stray spacing into a headline.
 */
export function displayName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/**
 * The headline on an event's signup page and its front-page banner: "Sign up for <name> now!".
 *
 * The name is the administrator's - it is whatever they called the event - and it is the only part of
 * the sentence they control. It is not escaped here: it is returned as plain text and the page renders
 * it as text (React never treats a string as markup), so a name containing angle brackets shows up as
 * angle brackets rather than as anything a browser would run.
 */
export function signupHeadline(name: string, lang: Language): string {
  const shown = displayName(name);
  return lang === "fr" ? `Inscrivez-vous à ${shown} dès maintenant !` : `Sign up for ${shown} now!`;
}

const DAY_MS = 86_400_000;

export type BannerKind = "live" | "signup" | "signup-closed" | "finished";

export interface EventSummary {
  id: string;
  name: string;
  status: "draft" | "signup" | "live" | "finished" | "cancelled";
  signupClosesAt: string | null;
  startsAt: string | null;
  finishedAt: string | null;
  /** The recorded champion (knockout events). Null for an event whose table decides it. */
  championName: string | null;
  /** The event's logo in the event-logos bucket, or null. */
  logoPath: string | null;
}

export interface Banner {
  kind: BannerKind;
  event: EventSummary;
}

/** Whether signup is open at `now`: the status says so and the closing time, if any, has not passed. */
export function signupIsOpen(event: Pick<EventSummary, "status" | "signupClosesAt">, now: Date): boolean {
  return (
    event.status === "signup" &&
    (event.signupClosesAt === null || Date.parse(event.signupClosesAt) > now.getTime())
  );
}

/** Whether a finished event is still inside its two weeks of congratulation. */
export function withinChampionWindow(event: EventSummary, now: Date): boolean {
  if (event.status !== "finished" || event.finishedAt === null) return false;
  return now.getTime() - Date.parse(event.finishedAt) < CHAMPION_BANNER_DAYS * DAY_MS;
}

/**
 * The banners to show, in the order to show them. What is happening now comes first: a live event,
 * then one taking signups, then one about to start, then the congratulations - and within a kind, the
 * one that matters soonest (signup closing first; the most recent finish first).
 */
export function frontPageBanners(events: EventSummary[], now: Date): Banner[] {
  const banners: Banner[] = [];
  for (const event of events) {
    if (event.status === "live") banners.push({ kind: "live", event });
    else if (event.status === "signup") banners.push({ kind: signupIsOpen(event, now) ? "signup" : "signup-closed", event });
    else if (withinChampionWindow(event, now)) banners.push({ kind: "finished", event });
  }

  const rank: Record<BannerKind, number> = { live: 0, signup: 1, "signup-closed": 2, finished: 3 };
  const time = (iso: string | null, fallback: number) => (iso === null ? fallback : Date.parse(iso));
  return banners.sort((a, b) => {
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    if (a.kind === "finished") return time(b.event.finishedAt, 0) - time(a.event.finishedAt, 0);
    if (a.kind === "signup") return time(a.event.signupClosesAt, Infinity) - time(b.event.signupClosesAt, Infinity);
    return time(a.event.startsAt, Infinity) - time(b.event.startsAt, Infinity) || (a.event.name < b.event.name ? -1 : 1);
  });
}
