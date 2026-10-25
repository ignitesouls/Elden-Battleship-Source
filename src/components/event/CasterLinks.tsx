import { twitchUrl, type Caster, type CastLanguage } from "../../lib/tournament/api";
import { useT } from "../../lib/language";

/**
 * A cast's language, as a small tag: 🍔 EN or 🥖 FR. A food emoji each rather than a flag - Windows
 * draws flag emoji as two plain letters - with the letters kept beside it for anyone the joke misses.
 * Shared by the language choice when asking to cast (LANGUAGE_EMOJI), so the two always match.
 */
export function CastLanguageTag({ lang }: { lang?: CastLanguage | null }) {
  const t = useT();
  const fr = lang === "fr";
  return (
    <span className="cast-lang" title={fr ? t("Cast in French", "Commenté en français") : t("Cast in English", "Commenté en anglais")}>
      <span aria-hidden>{LANGUAGE_EMOJI[fr ? "fr" : "en"]}</span> {fr ? "FR" : "EN"}
    </span>
  );
}

/** The emoji for each cast language - see CastLanguageTag. */
const LANGUAGE_EMOJI: Record<CastLanguage, string> = { en: "🍔", fr: "🥖" };

/** "🍔 English" / "🥖 Français": a language as the choice offers it, each in its own language. */
export function CastLanguageName({ lang }: { lang: CastLanguage }) {
  return (
    <>
      <span aria-hidden>{LANGUAGE_EMOJI[lang]}</span> {lang === "fr" ? "Français" : "English"}
    </>
  );
}

/**
 * A match's approved official casters, as one group: "🎙 Casts" then a pill per caster - their language
 * and their name - opening their Twitch. Shown beside the Multitwitch link wherever a match has one
 * (front page, "Your next match", Crew Quarters), so all three look alike. The Multitwitch grid stays
 * the players' own streams; the casts are their own group.
 *
 * Renders nothing with no approved caster.
 */
export function CasterLinks({ casters, style }: { casters: Caster[]; style?: React.CSSProperties }) {
  const t = useT();
  const linked = casters.filter((c) => twitchUrl(c.login));
  if (linked.length === 0) return null;
  return (
    <span className="cast-links" style={style}>
      <span className="muted">🎙 {linked.length === 1 ? t("Official cast", "Cast officiel") : t("Official casts", "Casts officiels")}</span>
      {linked.map((c) => (
        <a
          key={c.login}
          href={twitchUrl(c.login)!}
          target="_blank"
          rel="noreferrer"
          className="cast-pill"
          title={t(`Watch ${c.name}'s cast on Twitch`, `Regarder le cast de ${c.name} sur Twitch`)}
        >
          <CastLanguageTag lang={c.lang} />
          {c.name}
        </a>
      ))}
    </span>
  );
}
