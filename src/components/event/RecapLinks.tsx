import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../lib/language";

/**
 * The way from a bracket result to the post-match page of each game played in it (see fetchMatchGames).
 *
 * A single game is one "Recap" link; a series numbers its games in the order they were played, so a best
 * of seven still fits on the line. Nothing at all for a match with no recaps - a forfeit, a result set by
 * an administrator, or one whose recaps have aged out.
 */
export function RecapLinks({ keys, style }: { keys: string[] | undefined; style?: CSSProperties }) {
  const t = useT();
  if (!keys || keys.length === 0) return null;
  const to = (key: string) => `/match/${encodeURIComponent(key)}`;
  if (keys.length === 1) {
    return (
      <Link to={to(keys[0])} style={style}>
        {t("Recap", "Résumé")} ›
      </Link>
    );
  }
  return (
    <span style={style}>
      <span className="muted">{t("Recaps", "Résumés")} </span>
      {keys.map((key, i) => (
        <span key={key}>
          {i > 0 && <span className="muted"> · </span>}
          <Link to={to(key)} title={t(`Game ${i + 1}`, `Manche ${i + 1}`)}>
            {i + 1}
          </Link>
        </span>
      ))}
    </span>
  );
}
