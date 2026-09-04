import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

/** Where a room is in its life, as `rooms.status` spells it. */
export type SeatRoomStatus = "lobby" | "placement" | "battle" | "finished";

/**
 * The part of a resolved seat this hook itself understands.
 *
 * Both callers return more than this - the overlay adds nothing, the watch page adds a name and a
 * consent flag - so it is the floor rather than the whole answer. `userId` is the load-bearing one:
 * it is what there is to subscribe to, and it is why both RPCs return it even when the seat is null.
 */
export interface FollowedSeat {
  userId: string;
  roomCode: string | null;
  status: SeatRoomStatus | null;
  team: number | null;
}

export interface FollowedSeatState<T extends FollowedSeat> {
  /** True until the first answer arrives, so a caller draws nothing rather than flashing empty. */
  loading: boolean;
  /**
   * The match this key's owner is in, or null for a key that does not resolve at all.
   *
   * `session.roomCode === null` is the other empty case and a different one: a real key whose owner
   * is simply between matches. Both draw nothing; only the second is worth continuing to watch.
   */
  session: T | null;
}

/**
 * Follows one player from match to match, so a URL that names them never has to change.
 *
 * -- Why this is not a poll ----------------------------------------------------------------------
 *
 * The obvious implementation asks the database "which room now?" every few seconds, forever, for
 * every source in every scene on every stream - and now for every viewer in an audience as well.
 * Seven sources at a five-second poll is fifty thousand round trips a day from one streamer who left
 * OBS open, almost all of them answering "still the same room", and the site is in the middle of
 * cutting Supabase egress rather than adding a standing cost to it. Pointed at an audience the
 * arithmetic gets worse in a hurry: four hundred viewers polling is four hundred times that.
 *
 * So the resolution runs once, and then this watches the one thing that can change the answer: the
 * `players` rows belonging to that user. Joining a room inserts one, picking or switching a fleet
 * updates one, leaving or being kicked deletes one. Every transition either caller cares about is
 * one of those three, and nothing else in the database can move a player between matches.
 *
 * The filter is `user_id=eq.<their id>`, which is why both RPCs return that id even when there is no
 * seat to report - without it there would be nothing to subscribe to before their first match, and
 * no choice but to poll. DELETE carries the column because `players` is REPLICA IDENTITY FULL (see
 * 20260803020000), which is the reason a filtered subscription can see a player leave at all; that
 * migration was written for the kick screen and this is the second thing it buys.
 *
 * The room's OWN changes - status going to battle, shots landing, fleets confirming - are none of
 * this hook's business. Once a code is resolved the existing useRoom takes over and does exactly
 * what it does for a hand-pasted room URL. This only answers "which room".
 *
 * -- Re-resolving on rejoin ----------------------------------------------------------------------
 *
 * The channel re-resolves on every SUBSCRIBED, first join included, for the reason useRoom spells
 * out at length: a socket that dies quietly and comes back replays nothing, and the initial resolve
 * runs before the websocket has even connected. A source that missed the insert would sit on the
 * previous match, or on nothing, until somebody noticed and hit refresh - during a stream.
 *
 * -- Why it is generic ---------------------------------------------------------------------------
 *
 * Two features are built on it: the persistent OBS overlay (keyed by a private token) and a
 * streamer's public watch link (keyed by their Twitch handle). They differ only in what they hand
 * over at the door and what they get back with the seat. Everything above - the no-polling argument,
 * the subscription filter, the re-resolve on reconnect, the "same row, same render" guard - is
 * identical, subtle, and the sort of thing that gets fixed in one copy and not the other. It is one
 * copy on purpose.
 */
export function useFollowedSeat<T extends FollowedSeat>(
  /** The token or handle to resolve. Null or empty resolves to nothing, without a round trip. */
  key: string | null | undefined,
  /** Turns that key into a seat. Module-level in both callers, and held in a ref regardless. */
  resolve: (key: string) => Promise<T | null>,
  /**
   * Names the realtime channel, so two features watching the same person do not collide on one.
   *
   * A streamer running their own overlay while somebody watches their link is exactly that case,
   * and two subscriptions sharing a channel name is a bug that only shows up with an audience.
   */
  channelPrefix: string,
  /**
   * Whether two answers are the same picture, so an unchanged one does not re-render.
   *
   * Defaults to the three fields that decide which match is being drawn. A caller carrying more than
   * that - a consent flag the streamer can flip mid-match, say - passes its own, or the change never
   * reaches the screen.
   */
  same?: (prev: T, next: T | null) => boolean
): FollowedSeatState<T> {
  const [state, setState] = useState<FollowedSeatState<T>>({ loading: true, session: null });

  /**
   * The live resolve, held in a ref so the subscription effect below does not depend on it.
   *
   * Same shape as useRoom's `resyncRef`: the channel is torn down and rebuilt when the user id
   * changes and at no other time, so a re-render must not be able to drop it.
   */
  const resolveRef = useRef<() => void>(() => {});
  // The callbacks, likewise, so a caller passing an inline arrow cannot restart the resolve on every
  // render - which for the watch page would be a round trip per frame.
  const fnRef = useRef({ resolve, same });
  fnRef.current = { resolve, same };

  useEffect(() => {
    if (!key) {
      setState({ loading: false, session: null });
      return;
    }

    let cancelled = false;
    setState({ loading: true, session: null });

    const run = () => {
      void fnRef.current.resolve(key).then((session) => {
        if (cancelled) return;
        setState((prev) => {
          if (prev.loading || !prev.session) return { loading: false, session };
          const unchanged = fnRef.current.same
            ? fnRef.current.same(prev.session, session)
            : prev.session.roomCode === (session?.roomCode ?? null) &&
              prev.session.team === (session?.team ?? null) &&
              prev.session.status === (session?.status ?? null);
          // Same row, same render. A source that re-rendered on every realtime message would remount
          // the whole board underneath it, which on stream reads as a flicker.
          return unchanged ? prev : { loading: false, session };
        });
      });
    };

    resolveRef.current = run;
    run();

    return () => {
      cancelled = true;
    };
  }, [key]);

  const userId = state.session?.userId ?? null;

  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`${channelPrefix}-${userId}`)
      .on(
        "postgres_changes",
        // Every event, because all three matter and they mean different things: INSERT is a room
        // joined, UPDATE is a fleet picked or switched, DELETE is a room left or a player kicked.
        { event: "*", schema: "public", table: "players", filter: `user_id=eq.${userId}` },
        () => resolveRef.current()
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") resolveRef.current();
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, channelPrefix]);

  return state;
}
