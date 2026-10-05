import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchEvent, fetchEventConfig, type EventConfig, type EventDetail } from "../lib/tournament/api";
import { rulebook, type RuleBlock } from "../lib/tournament/rulebook";
import { displaySquareSet, squareSetLabel } from "../lib/squareSets";
import { isSupabaseConfigured } from "../lib/supabase";
import { useLanguage, useT } from "../lib/language";
import { LoadingScreen } from "../components/BrandMark";
import "../components/Tournament.css";

function Block({ block }: { block: RuleBlock }) {
  if (typeof block === "string") return <p style={{ margin: "0.3rem 0" }}>{block}</p>;
  if ("ordered" in block) return <ol style={{ margin: "0.3rem 0" }}>{block.ordered.map((item) => <li key={item}>{item}</li>)}</ol>;
  return <ul style={{ margin: "0.3rem 0" }}>{block.bullets.map((item) => <li key={item}>{item}</li>)}</ul>;
}

/**
 * An event's rules: what the organizers add for this event, then the shared rulebook with the event's
 * own numbers in it (see lib/tournament/rulebook).
 *
 * Its own page rather than a panel on the event page, so the link can be pasted into Discord and a
 * referee can keep it open beside a match. The same page from signup to the final: the format reads
 * "set when the event starts" until it is, then fills in.
 */
export function EventRules() {
  const { id = "" } = useParams();
  const t = useT();
  const lang = useLanguage();
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

  const sections = useMemo(() => {
    if (!event) return [];
    const set = event.rules.square_set;
    return rulebook({
      eventName: event.name,
      teamSize: event.team_size,
      rules: event.rules,
      setLabel: set ? squareSetLabel(set) : null,
      bossBoard: !set || displaySquareSet(set) === "bosses",
      format: config?.format ?? null,
    }, lang);
  }, [event, config, lang]);

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

  const extra = event.extra_rules.trim();

  return (
    <div className="stack" style={{ width: "min(720px, 100%)" }}>
      <div style={{ textAlign: "center" }}>
        <h1>{t(`${event.name} rules`, `Règlement - ${event.name}`)}</h1>
        <Link to={`/event/${event.id}`}>{t("Back to the event", "Retour à l'événement")}</Link>
      </div>

      {extra && (
        <div className="panel stack">
          <h3>{t("Rules for this event", "Règles propres à cet événement")}</h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
            {t("Where these differ from the rules below, these apply.", "En cas de différence avec les règles ci-dessous, celles-ci s'appliquent.")}
          </p>
          <div style={{ whiteSpace: "pre-wrap" }}>{extra}</div>
        </div>
      )}

      {sections.map((section) => (
        <div className="panel stack" key={section.n}>
          <h3>
            {section.n}. {section.title}
          </h3>
          {section.intro && <p style={{ margin: 0 }}>{section.intro}</p>}
          {section.rules.map((rule) => (
            <div key={rule.n} id={`rule-${rule.n}`}>
              <strong>
                {rule.n} {rule.title}
              </strong>
              {rule.body.map((block, i) => (
                <Block key={i} block={block} />
              ))}
            </div>
          ))}
        </div>
      ))}

      <div style={{ textAlign: "center" }}>
        <Link to={`/event/${event.id}`}>{t("Back to the event", "Retour à l'événement")}</Link>
      </div>
    </div>
  );
}
