import { twitchUrl, type Caster } from "../../lib/tournament/api";
import { useT } from "../../lib/language";

/**
 * A match's approved official casters, one button each, opening their Twitch - shown beside the
 * Multitwitch link wherever a match has one (front page, "Your next match", Crew Quarters), so all
 * three look alike. The Multitwitch grid stays the players' own streams; the cast is its own button.
 *
 * Renders nothing with no approved caster.
 */
export function CasterLinks({ casters, style }: { casters: Caster[]; style?: React.CSSProperties }) {
  const t = useT();
  return (
    <>
      {casters.map((c) => {
        const url = twitchUrl(c.login);
        return url ? (
          <a key={c.login} href={url} target="_blank" rel="noreferrer" className="link-button" style={style}>
            🎙 {t(`Official cast: ${c.name}`, `Cast officiel : ${c.name}`)}
          </a>
        ) : null;
      })}
    </>
  );
}
