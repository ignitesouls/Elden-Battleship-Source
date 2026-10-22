import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { officialStatsEnabled } from "../lib/tournament/api";
import { isSupabaseConfigured } from "../lib/supabase";
import { useT } from "../lib/language";

/**
 * The leaderboard's way to the Official record (pages/Official), where official tournament matches are
 * counted apart from the everyday numbers.
 *
 * It does not exist until the first tournament has gone live. Before that the leaderboard is exactly
 * what it has always been, with no "Official" link and no mention of a feature nobody has seen. After
 * that it stays, even if that tournament is later cancelled: official games count for good, so the
 * place they are counted cannot come and go with the event.
 *
 * Reads never break the page - if the tournament tables aren't there yet, or the read fails, this
 * simply renders nothing.
 */
export function OfficialRecordLink() {
  const t = useT();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let cancelled = false;
    void officialStatsEnabled().then((on) => {
      if (!cancelled && on) setEnabled(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!enabled) return null;

  return (
    <p style={{ margin: "0.3rem 0" }}>
      <Link to="/official" style={{ color: "var(--accent-bright)", fontWeight: 600 }}>
        {t("Official record - tournament matches only", "Palmarès officiel - matchs de tournoi uniquement")}
      </Link>
    </p>
  );
}
