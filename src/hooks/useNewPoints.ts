import { useEffect, useRef, useState } from "react";
import type { TalkingPoint } from "../lib/talkingPoints";

/** How long a new point stays lit on the desk - long enough to catch the eye of someone mid-sentence. */
const FLASH_MS = 4000;

/**
 * The live talking points that have just arrived: lit for a moment in the list (components/TalkingPoints),
 * and the newest held for the bar pinned to the top of the desk (pages/CasterControl), so a caster
 * scrolled anywhere still sees it land.
 *
 * Only points that arrive while the desk is open - the backlog on load is history, not news.
 */
export function useNewPoints(live: TalkingPoint[], loading: boolean) {
  const seen = useRef<Set<string> | null>(null);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(() => new Set());
  const [latest, setLatest] = useState<TalkingPoint | null>(null);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (loading) return;
    if (seen.current === null) {
      seen.current = new Set(live.map((p) => p.id));
      return;
    }
    const fresh = live.filter((p) => !seen.current!.has(p.id));
    if (fresh.length === 0) return;
    const ids = fresh.map((p) => p.id);
    ids.forEach((id) => seen.current!.add(id));
    // live is newest first.
    setLatest(fresh[0]);
    setFlashing((prev) => new Set([...prev, ...ids]));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setFlashing((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
    }, FLASH_MS);
    timers.current.add(timer);
  }, [live, loading]);

  return { flashing, latest, dismiss: () => setLatest(null) };
}
