import { useEffect, useState } from "react";
import { fetchMyCrews, type MyCrew } from "../lib/tournament/api";
import { isSupabaseConfigured } from "../lib/supabase";

/** The last answer, by account - kept for the life of the tab. */
const cache = new Map<string, MyCrew[]>();

/**
 * The crews the signed-in player is on in open or running events, for the top bar's Crew Quarters link.
 *
 * The bar is on every page, so this asks ONCE per account per tab and remembers the answer: moving
 * between pages costs no request (every REST call is a metered log line). Signing in as someone else
 * asks again. A team approved mid-session shows up on the next reload, or straight away on the event
 * page, which has its own button.
 */
export function useMyCrews(userId: string | null): MyCrew[] {
  const [crews, setCrews] = useState<MyCrew[]>(() => (userId ? cache.get(userId) ?? [] : []));

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) {
      setCrews([]);
      return;
    }
    const known = cache.get(userId);
    if (known) {
      setCrews(known);
      return;
    }
    let cancelled = false;
    fetchMyCrews(userId)
      .then((found) => {
        cache.set(userId, found);
        if (!cancelled) setCrews(found);
      })
      .catch(() => undefined); // a link in the top bar is never worth an error
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return crews;
}
