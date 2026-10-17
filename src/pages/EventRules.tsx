import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchEvent, fetchEventConfig, type EventConfig, type EventDetail } from "../lib/tournament/api";
import { isSupabaseConfigured } from "../lib/supabase";
import { useT } from "../lib/language";
import { LoadingScreen } from "../components/BrandMark";
import { EventRulebook } from "../components/event/EventRulebook";
import "../components/Tournament.css";

/**
 * An event's rules, on a page of their own (the rulebook itself is components/event/EventRulebook).
 *
 * Its own page rather than a panel on the event page, so the link can be pasted into Discord and a
 * referee can keep it open beside a match. The same page from signup to the final: the format reads
 * "set when the event starts" until it is, then fills in.
 */
export function EventRules() {
  const { id = "" } = useParams();
  const t = useT();
  const [event, setEvent] = useState<EventDetail | null | undefined>(undefined);
  const [config, setConfig] = useState<EventConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let cancelled = false;
    void (async () => {
      try {
        const found = await fetchEvent(id);
        if (cancelled) return;
        setEvent(found);
        if (found) {
          const saved = await fetchEventConfig(id);
          if (!cancelled) setConfig(saved);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!isSupabaseConfigured) {
    return <div className="panel">{t("Supabase isn't configured.", "Supabase n'est pas configuré.")}</div>;
  }
  if (event === undefined && !error) return <LoadingScreen>{t("Loading the rules...", "Chargement du règlement...")}</LoadingScreen>;
  if (!event) {
    return (
      <div className="panel stack" style={{ width: "min(560px, 100%)", alignItems: "center", textAlign: "center" }}>
        {error ? (
          <span className="error-text">{error}</span>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t("There's no event here - it may not have opened yet.", "Il n'y a pas d'événement ici - il n'est peut-être pas encore ouvert.")}
          </p>
        )}
        <Link to="/">{t("Back to the harbor", "Retour au port")}</Link>
      </div>
    );
  }

  return (
    <div className="stack" style={{ width: "min(720px, 100%)" }}>
      <div style={{ textAlign: "center" }}>
        <h1>{t(`${event.name} rules`, `Règlement - ${event.name}`)}</h1>
        <Link to={`/event/${event.id}`}>{t("Back to the event", "Retour à l'événement")}</Link>
      </div>

      <EventRulebook event={event} config={config} />

      <div style={{ textAlign: "center" }}>
        <Link to={`/event/${event.id}`}>{t("Back to the event", "Retour à l'événement")}</Link>
      </div>
    </div>
  );
}
