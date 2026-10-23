import { useEffect, useRef, useState } from "react";
import { teamHex } from "../lib/teamColors";
import type { TalkingPoint } from "../lib/talkingPoints";
import { CARD_MS } from "../lib/castAux";
import { useT } from "../lib/language";

interface Props {
  before: TalkingPoint[];
  live: TalkingPoint[];
  loading: boolean;
  /** Live points that just arrived, lit for a moment - see hooks/useNewPoints. */
  flashing?: ReadonlySet<string>;
  /** Which player box a point would go over, or null when it has none (a crew-wide point, an empty seat). */
  slotFor: (p: TalkingPoint) => number | null;
  /** Put a point over its player's box. */
  onShow: (p: TalkingPoint) => void;
}

/** How many live points show before the list scrolls - a match runs to dozens, the newest matter. */
const LIVE_HEIGHT = "16rem";

/** How long a big moment offers itself before it gives up - long enough to finish a sentence. */
const OFFER_MS = 10000;

/** Whether big moments offer themselves, kept in this browser between shows. Best-effort either way. */
const OFFER_KEY = "eb_talking_points_offer";

function readOffer(): boolean {
  try {
    return localStorage.getItem(OFFER_KEY) === "1";
  } catch {
    return false;
  }
}

function Point({
  p,
  onAir,
  show,
  flash = false,
}: {
  p: TalkingPoint;
  onAir: boolean;
  show: (() => void) | null;
  flash?: boolean;
}) {
  const t = useT();
  return (
    <div
      className={`row${flash ? " tp-flash" : ""}`}
      style={{
        gap: "0.45rem",
        alignItems: "baseline",
        fontSize: "0.78rem",
        ["--tp-color" as string]: p.team === null ? "var(--accent)" : teamHex(p.team),
      }}
    >
      <span aria-hidden style={{ flexShrink: 0 }}>{p.emoji}</span>
      <span
        style={{
          minWidth: 0,
          flex: 1,
          color: p.big ? "var(--accent)" : "var(--text)",
          fontWeight: p.big ? 600 : 400,
          borderLeft: `2px solid ${p.team === null ? "var(--text-dim)" : teamHex(p.team)}`,
          paddingLeft: "0.4rem",
        }}
      >
        {p.text}
      </span>
      {show && (
        <button
          onClick={show}
          style={{ flexShrink: 0, fontSize: "0.68rem", padding: "0.1rem 0.4rem", alignItems: "center", gap: 0 }}
          title={`${t("The barnacle says:", "Le bernacle dira :")} "${p.line}"`}
          className={onAir ? "primary row" : "row"}
        >
          {/* Which barnacle will say it, so the caster is not surprised by the face on stream. */}
          <img
            src={`${import.meta.env.BASE_URL}media/barnacles/barnacle-${p.mood}.png`}
            alt=""
            style={{ width: "1.1rem", height: "1.1rem", objectFit: "contain", marginRight: "0.2rem" }}
          />
          {onAir ? t("On air", "À l'écran") : t("Show", "Afficher")}
        </button>
      )}
    </div>
  );
}

/**
 * The caster's talking points - see lib/talkingPoints - and the button that puts one on stream.
 *
 * Live first, because it is what the caster needs mid-sentence, newest at the top so the shot that just
 * landed is where the eye already is. The history below it is the pre-show crib sheet: it holds still
 * for the whole match, since nothing in it changes until the match is archived.
 *
 * -- What reaches the stream ---------------------------------------------------------------------
 *
 * Only what the caster sends. Every point about one player has a Show button, which puts it over that
 * player's box for a few seconds (lib/castAux's CARD). With "Offer big moments" ticked, a world record
 * or personal best that lands mid-match also comes up at the top of the panel with its own button for a
 * few seconds - still the caster's click, never automatic: something on stream the caster did not
 * choose is something they then have to explain.
 */
export function TalkingPoints({ before, live, loading, flashing, slotFor, onShow }: Props) {
  const t = useT();
  const label = { fontSize: "0.7rem", letterSpacing: "0.06em", textTransform: "uppercase" as const };

  // A new point lands at the top: take the list back there, wherever the caster had scrolled it.
  const listRef = useRef<HTMLDivElement | null>(null);
  const newest = live[0]?.id;
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [newest]);

  const [onAir, setOnAir] = useState<string | null>(null);
  const airTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(airTimer.current ?? undefined), []);
  const show = (p: TalkingPoint) => {
    onShow(p);
    setOnAir(p.id);
    clearTimeout(airTimer.current ?? undefined);
    airTimer.current = setTimeout(() => setOnAir(null), CARD_MS);
  };
  const showFor = (p: TalkingPoint) => (slotFor(p) === null ? null : () => show(p));

  // -- Big moments, offered ----------------------------------------------------------------------
  const [offerBig, setOfferBig] = useState(readOffer);
  const [offered, setOffered] = useState<TalkingPoint | null>(null);
  /** Every live point already on the desk, so only a NEW one offers itself - never the backlog on load. */
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (loading) return;
    if (seen.current === null) {
      seen.current = new Set(live.map((p) => p.id));
      return;
    }
    const fresh = live.filter((p) => !seen.current!.has(p.id));
    for (const p of fresh) seen.current.add(p.id);
    if (!offerBig) return;
    // live is newest first, so the first fresh big one is the latest.
    const big = fresh.find((p) => p.big && slotFor(p) !== null);
    if (big) setOffered(big);
  }, [live, loading, offerBig, slotFor]);
  useEffect(() => {
    if (!offered) return;
    const timer = setTimeout(() => setOffered(null), OFFER_MS);
    return () => clearTimeout(timer);
  }, [offered]);

  const toggleOffer = (on: boolean) => {
    setOfferBig(on);
    if (!on) setOffered(null);
    try {
      localStorage.setItem(OFFER_KEY, on ? "1" : "0");
    } catch {
      /* just won't be remembered next time */
    }
  };

  return (
    // No panel of its own: it sits in the desk's Talking points group, which is the box.
    <div className="stack" style={{ gap: "0.35rem" }}>
      <label className="row" style={{ gap: "0.35rem", fontSize: "0.72rem", alignItems: "center" }}>
        <input type="checkbox" checked={offerBig} onChange={(e) => toggleOffer(e.target.checked)} />
        {t("Offer big moments (world records, personal bests)", "Proposer les grands moments (records du monde, records personnels)")}
      </label>

      {offered && (
        <div
          className="row"
          style={{ gap: "0.45rem", alignItems: "center", padding: "0.35rem 0.45rem", border: "1px solid var(--accent)", borderRadius: 6 }}
        >
          {/* The barnacle's line, since this one is offered for the stream. */}
          <span style={{ flex: 1, minWidth: 0, fontSize: "0.78rem", fontWeight: 600 }}>
            {offered.emoji} {offered.line}
          </span>
          <button
            className="primary"
            onClick={() => {
              show(offered);
              setOffered(null);
            }}
            style={{ flexShrink: 0, fontSize: "0.72rem" }}
          >
            {t("Show on stream", "Afficher à l'écran")}
          </button>
          <button onClick={() => setOffered(null)} style={{ flexShrink: 0, fontSize: "0.72rem" }} aria-label={t("Dismiss", "Ignorer")}>
            ✕
          </button>
        </div>
      )}

      {loading ? (
        <span className="muted" style={{ fontSize: "0.75rem" }}>
          {t("Reading the crews' history...", "Lecture de l'historique des équipages...")}
        </span>
      ) : (
        <>
          <span className="muted" style={label}>{t("This match", "Ce match")}</span>
          {live.length === 0 ? (
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              {t("Nothing yet - points appear here as squares fall.", "Rien pour l'instant - les points apparaissent ici à chaque case prise.")}
            </span>
          ) : (
            <div ref={listRef} className="stack" style={{ gap: "0.3rem", maxHeight: LIVE_HEIGHT, overflowY: "auto" }}>
              {live.map((p) => (
                <Point key={p.id} p={p} onAir={onAir === p.id} show={showFor(p)} flash={flashing?.has(p.id)} />
              ))}
            </div>
          )}
          <span className="muted" style={{ ...label, marginTop: "0.3rem" }}>{t("Coming in", "Avant le match")}</span>
          {before.length === 0 ? (
            <span className="muted" style={{ fontSize: "0.75rem" }}>{t("No history on this board yet.", "Pas encore d'historique sur ce plateau.")}</span>
          ) : (
            before.map((p) => <Point key={p.id} p={p} onAir={onAir === p.id} show={showFor(p)} />)
          )}
        </>
      )}
    </div>
  );
}
