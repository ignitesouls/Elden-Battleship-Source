import { useEffect, useMemo, useState } from "react";
import { fetchProfileBits, type PlayerProfileBits } from "../lib/tournament/api";

/**
 * Avatars and Twitch logins for a set of accounts - one request, made again only when the set of
 * accounts changes (not on every refresh of the page around it). An empty map until it arrives, and if
 * it fails: callers fall back to the default logo and to no stream link.
 */
export function useProfileBits(userIds: readonly string[]): Map<string, PlayerProfileBits> {
  const key = useMemo(() => [...new Set(userIds)].sort().join(","), [userIds]);
  const [bits, setBits] = useState<Map<string, PlayerProfileBits>>(new Map());
  useEffect(() => {
    if (!key) {
      setBits(new Map());
      return;
    }
    let cancelled = false;
    fetchProfileBits(key.split(","))
      .then((found) => !cancelled && setBits(found))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key]);
  return bits;
}
