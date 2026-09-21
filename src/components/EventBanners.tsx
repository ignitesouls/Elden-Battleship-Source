import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchFrontPageEvents, fetchMyInbox, type InboxInvite } from "../lib/tournament/api";
import { frontPageBanners, signupHeadline, type Banner, type EventSummary } from "../lib/tournament/frontPage";
import { isSupabaseConfigured } from "../lib/supabase";
import { serverNow } from "../lib/serverTime";
import { useAuthProfile } from "../hooks/useAuthProfile";
import { useLanguage, useT } from "../lib/language";
import "./Tournament.css";

/** How often the banners are re-read. Events change over hours and days, so a minute is generous. */
const REFRESH_MS = 60_000;

/** How many event banners the front page shows before folding the rest behind a button. */
const MAX_BANNERS = 3;

/**
 * The tournament notices on the front page: one banner per event that has something to say, and a
 * notice for each team that has invited the signed-in player.
 *
 * Renders NOTHING when there is nothing to say - no empty panel, no "no events" line - because the
 * front page is for playing, and the tournament system should be invisible until an administrator
 * opens an event.
 *
 * -- It must never be able to break the front page ---------------------------------------------------
 * Every read here is best-effort. If the tournament tables are not there (the migrations not yet
 * applied to this project), or the network hiccups, or a policy refuses, the banners stay empty and
 * the join form above them carries on working. A failure in an optional feature is not allowed to take
 * down the page people use to get into a match.
 *
 * -- Polled, not subscribed -------------------------------------------------------------------------
 * Same reasoning as the live-battles list on this page: the front page is the one screen people leave
 * open, so a realtime channel here would be held by every idle tab on the site. Nothing is fetched
 * while the tab is hidden.
 */
export function EventBanners() {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const profile = useAuthProfile();
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [inbox, setInbox] = useState<InboxInvite[]>([]);
  const userId = profile?.isTwitch ? profile.userId : null;

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let cancelled = false;

    const read = () => {
      if (document.visibilityState !== "visible") return;
      fetchFrontPageEvents(serverNow())
        .then((rows) => !cancelled && setEvents(rows))
        .catch(() => undefined);
    };

    read();
    const timer = setInterval(read, REFRESH_MS);
    document.addEventListener("visibilitychange", read);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, []);

  // Invitations belong to a Twitch account, so an anonymous visitor never asks. Re-read when the
  // account changes, so signing in shows the invitation without a reload.
  useEffect(() => {
    if (!isSupabaseConfigured || !userId) {
      setInbox([]);
      return;
    }
    let cancelled = false;
    fetchMyInbox()
      .then((rows) => !cancelled && setInbox(rows))
      .catch(() => !cancelled && setInbox([]));
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const banners = frontPageBanners(events, new Date(serverNow()));
  if (banners.length === 0 && inbox.length === 0) return null;

  // With several events running at once the banners would push the join form off the screen. The most
  // pressing few are shown (the list is already in order of what matters now) and the rest fold away.
  const shown = expanded ? banners : banners.slice(0, MAX_BANNERS);
  const hidden = banners.length - shown.length;

  return (
    <div className="stack" style={{ gap: "0.6rem" }}>
      {inbox.map((invite) => (
        <InviteNotice key={invite.invite_id} invite={invite} />
      ))}
      {shown.map((banner) => (
        <EventBanner key={banner.event.id} banner={banner} />
      ))}
      {hidden > 0 && (
        <button onClick={() => setExpanded(true)} style={{ alignSelf: "center" }}>
          {t(`Show ${hidden} more event${hidden === 1 ? "" : "s"}`, `Voir ${hidden} autre(s) événement(s)`)}
        </button>
      )}
    </div>
  );
}

/** A date for a banner: short, in the reader's language, in their own time zone. */
function shortDate(iso: string, lang: "en" | "fr"): string {
  return new Date(iso).toLocaleDateString(lang === "fr" ? "fr-FR" : undefined, { month: "short", day: "numeric" });
}

function EventBanner({ banner }: { banner: Banner }) {
  const t = useT();
  const lang = useLanguage();
  const { event, kind } = banner;
  const to = `/event/${event.id}`;

  if (kind === "signup") {
    return (
      <div className="panel stack event-banner event-banner--signup" style={{ gap: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>{signupHeadline(event.name, lang)}</h3>
        {event.signupClosesAt && (
          <span className="muted">
            {t(`Signup closes ${shortDate(event.signupClosesAt, lang)}`, `Inscriptions jusqu'au ${shortDate(event.signupClosesAt, lang)}`)}
          </span>
        )}
        <div>
          <Link to={to} className="link-button primary">
            {t("Sign up", "S'inscrire")}
          </Link>
        </div>
      </div>
    );
  }

  if (kind === "signup-closed") {
    return (
      <div className="panel stack event-banner" style={{ gap: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>{event.name}</h3>
        <span className="muted">{t("Signup has closed - starting soon.", "Les inscriptions sont closes - début imminent.")}</span>
        <div>
          <Link to={to} className="link-button">
            {t("See who's in", "Voir les inscrits")}
          </Link>
        </div>
      </div>
    );
  }

  if (kind === "live") {
    return (
      <div className="panel stack event-banner event-banner--live" style={{ gap: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>{t(`${event.name} is underway`, `${event.name} est en cours`)}</h3>
        <div>
          <Link to={to} className="link-button primary">
            {t("View the bracket", "Voir le tableau")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="panel stack event-banner event-banner--finished" style={{ gap: "0.5rem" }}>
      <h3 style={{ margin: 0 }}>
        {event.championName
          ? t(`Congratulations to ${event.championName}, champions of ${event.name}!`, `Félicitations à ${event.championName}, vainqueurs de ${event.name} !`)
          : t(`${event.name} has finished`, `${event.name} est terminé`)}
      </h3>
      <div>
        <Link to={to} className="link-button">
          {t("See the results", "Voir les résultats")}
        </Link>
      </div>
    </div>
  );
}

function InviteNotice({ invite }: { invite: InboxInvite }) {
  const t = useT();
  const who = invite.captain_name ?? t("A captain", "Un capitaine");
  return (
    <div className="panel stack event-banner event-banner--invite" style={{ gap: "0.5rem" }}>
      <strong>
        {t(
          `${who} invited you to join ${invite.team_name} for ${invite.tournament_name}`,
          `${who} vous invite à rejoindre ${invite.team_name} pour ${invite.tournament_name}`,
        )}
      </strong>
      <div>
        <Link to={`/event/${invite.tournament_id}`} className="link-button primary">
          {t("Review the invitation", "Voir l'invitation")}
        </Link>
      </div>
    </div>
  );
}
