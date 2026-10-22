import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabase";

/**
 * Who is casting which stream of a room, and which of them has the board.
 *
 * -- Desks are per stream --------------------------------------------------------------------------
 *
 * A stream is one OBS scene, and its sources follow the account whose overlay token they were made
 * with - the desk's OWNER. A room can carry several: an English stream and a French one of the same
 * match, each with its own camera, plates and Starting Soon. So a desk belongs to an owner, every
 * caster's desk starts on their own, and a co-caster sitting with somebody else picks that desk from
 * the list this builds (see castTopic in lib/overlayCast for the channels each desk then uses).
 *
 * -- One hand on the board ----------------------------------------------------------------------------
 *
 * Two desks on one stream used to both send their whole view, names and all, on every shot - and
 * whichever arrived last was what viewers saw. Now exactly one desk on a stream sends: the one that
 * most recently took it. The others mirror what it sends and can take it with one click.
 *
 * "Most recently" is a counter, not a clock: taking sets `took` to one more than anyone on the desk
 * has, so two machines whose clocks disagree still agree on who took last. Ties - nobody has taken
 * yet - go to the lowest presence key, and whoever that elects takes at once, so a caster who joins
 * later with a fresh, unmirrored view can never be elected over the desk that is already live.
 *
 * Presence rather than a table: who is at a desk is only true while their page is open, and the
 * moment the holding desk closes its entry goes and the next one takes over by itself.
 */

const topic = (code: string) => `cast-desks:${code.toUpperCase()}`;

interface Seat {
  /** The caster's account. */
  user: string;
  name: string;
  /** Whose stream they are at, and that owner's name. */
  desk: string;
  deskName: string;
  took: number;
}

export interface DeskCaster {
  key: string;
  user: string;
  name: string;
  driving: boolean;
}

export interface Desk {
  owner: string;
  name: string;
  casters: DeskCaster[];
}

export interface CastDesks {
  /** Every desk running in the room, the caster's own first. */
  desks: Desk[];
  /** The desk this page is at. */
  desk: Desk | null;
  /** Whether this page has the board. False until the first presence sync says so. */
  driving: boolean;
  /** Who does, when it isn't this page. */
  driver: DeskCaster | null;
  take: () => void;
}

/** The elected driver of one desk's seats: highest `took`, then lowest key. */
function electDriver(seats: Array<[string, Seat]>): string | null {
  let best: [string, Seat] | null = null;
  for (const entry of seats) {
    if (!best || entry[1].took > best[1].took || (entry[1].took === best[1].took && entry[0] < best[0])) best = entry;
  }
  return best?.[0] ?? null;
}

/**
 * The room's desks, from this page's point of view.
 *
 * `me` null (no account behind the page - the old /cast/CODE route) switches all of it off: such a
 * desk drives the room-wide topic alone, exactly as before. `deskOwner` is the stream this page is
 * at; the caster's own when they haven't picked another.
 */
export function useCastDesks(
  code: string | undefined,
  me: { user: string; name: string } | null,
  deskOwner: string | null,
  deskName: string
): CastDesks {
  // One presence entry per open page, so two tabs of one account are two seats rather than one.
  const key = useMemo(() => crypto.randomUUID(), []);
  const [seats, setSeats] = useState<Map<string, Seat>>(new Map());
  const [synced, setSynced] = useState(false);
  const [took, setTook] = useState(0);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const subscribed = useRef(false);
  /** Steps when the channel comes up, so the seat is announced on it. */
  const [trackTick, setTrackTick] = useState(0);

  const user = me?.user ?? null;
  const name = me?.name ?? "";
  const enabled = isSupabaseConfigured && !!code && !!user && !!deskOwner;

  useEffect(() => {
    if (!enabled) return;
    const channel = supabase.channel(topic(code!), { config: { presence: { key } } });
    channelRef.current = channel;
    channel
      .on("presence", { event: "sync" }, () => {
        const next = new Map<string, Seat>();
        for (const [k, metas] of Object.entries(channel.presenceState<Seat>())) {
          const last = metas[metas.length - 1];
          if (last) next.set(k, { user: last.user, name: last.name, desk: last.desk, deskName: last.deskName, took: last.took });
        }
        setSeats(next);
        setSynced(true);
      })
      .subscribe((status) => {
        subscribed.current = status === "SUBSCRIBED";
        if (status === "SUBSCRIBED") setTrackTick((n) => n + 1);
      });
    return () => {
      subscribed.current = false;
      channelRef.current = null;
      setSeats(new Map());
      setSynced(false);
      void supabase.removeChannel(channel);
    };
  }, [enabled, code, key]);

  // Re-announce this seat whenever anything in it changes, and once the channel is up.
  useEffect(() => {
    const channel = channelRef.current;
    if (!enabled || !channel || !subscribed.current) return;
    void channel.track({ user, name, desk: deskOwner, deskName, took } satisfies Seat);
  }, [enabled, user, name, deskOwner, deskName, took, trackTick]);

  // A new desk is a fresh seat: nothing taken there yet.
  useEffect(() => setTook(0), [deskOwner]);

  /**
   * This page's view of its own seat, folded into what presence last said - the sync for a change
   * just made has not come back yet, and the election must not run on the stale copy of it.
   */
  const all = useMemo(() => {
    const next = new Map(seats);
    if (enabled && synced) next.set(key, { user: user!, name, desk: deskOwner!, deskName, took });
    return next;
  }, [seats, enabled, synced, key, user, name, deskOwner, deskName, took]);

  const desks = useMemo(() => {
    const byOwner = new Map<string, Array<[string, Seat]>>();
    for (const entry of all) {
      const list = byOwner.get(entry[1].desk) ?? [];
      list.push(entry);
      byOwner.set(entry[1].desk, list);
    }
    const out: Desk[] = [];
    for (const [owner, list] of byOwner) {
      const driverKey = electDriver(list);
      // The owner's own name for their desk when they are at it, else whatever a co-caster carried.
      const named = list.find(([, s]) => s.user === owner) ?? list[0];
      out.push({
        owner,
        name: named[1].user === owner ? named[1].name : named[1].deskName,
        casters: list
          .map(([k, s]) => ({ key: k, user: s.user, name: s.name, driving: k === driverKey }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
    // The caster's own desk is always on the list, so there is a way back to it.
    if (user && !byOwner.has(user)) out.push({ owner: user, name, casters: [] });
    return out.sort((a, b) => (a.owner === user ? -1 : b.owner === user ? 1 : a.name.localeCompare(b.name)));
  }, [all, user, name]);

  const desk = desks.find((d) => d.owner === deskOwner) ?? null;
  const mine = desk?.casters.find((c) => c.key === key) ?? null;
  const driving = !enabled ? true : synced && !!mine?.driving;
  const driver = desk?.casters.find((c) => c.driving) ?? null;

  const take = useCallback(() => {
    let max = 0;
    for (const s of all.values()) if (s.desk === deskOwner) max = Math.max(max, s.took);
    setTook(max + 1);
  }, [all, deskOwner]);

  // Elected without having taken - first at the desk, or the holder just left: take it properly, so
  // the next caster to sit down can't be elected over this one on a tie.
  useEffect(() => {
    if (enabled && driving && took === 0) take();
  }, [enabled, driving, took, take]);

  return { desks, desk, driving, driver: driving ? null : driver, take };
}
