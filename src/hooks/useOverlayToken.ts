import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { resolveOverlaySession, type OverlaySession } from "../lib/streamOverlay";

export interface OverlayTokenState {
  /** True until the first answer arrives, so a source draws nothing rather than flashing empty. */
  loading: boolean;
  /**
   * The match the token's owner is in, or null for a token that does not resolve at all.
   *
   * `session.roomCode === null` is the other empty case and a different one: a real token whose owner
   * is simply between matches. Both draw nothing; only the second is worth continuing to watch.
   */
  session: OverlaySession | null;
}

/**
 * Follows the token's owner from match to match, so an OBS Browser Source URL never has to change.
 *
 * -- Why this is not a poll ----------------------------------------------------------------------
 *
 * The obvious implementation asks the database "which room now?" every few seconds, forever, for
 * every source in every scene on every stream. Seven sources at a five-second poll is fifty
 * thousand round trips a day from one streamer who left OBS open, almost all of them answering
 * "still the same room" - and the site is in the middle of cutting Supabase egress, not adding a
 * standing cost to it.
 *
 * So the resolution runs once, and then this watches the one thing that can change the answer: the
 * `players` rows belonging to that user. Joining a room inserts one, picking or switching a fleet
 * updates one, leaving or being kicked deletes one. Every transition the overlay cares about is one
 * of those three, and nothing else in the database can move a player between matches.
 *
 * The filter is `user_id=eq.<their id>`, which is why overlay_session returns that id even when
 * there is no seat to report - without it there would be nothing to subscribe to before their first
 * match, and no choice but to poll. DELETE carries the column because `players` is REPLICA IDENTITY
 * FULL (see 20260803020000), which is the reason a filtered subscription can see a player leave at
 * all; that migration was written for the kick screen and this is the second thing it buys.
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
 */
export function useOverlayToken(token: string | null | undefined): OverlayTokenState {
  const [state, setState] = useState<OverlayTokenState>({ loading: true, session: null });

  /**
   * The live resolve, held in a ref so the subscription effect below does not depend on it.
   *
   * Same shape as useRoom's `resyncRef`: the channel is torn down and rebuilt when the user id
   * changes and at no other time, so a re-render must not be able to drop it.
   */
  const resolveRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!token) {
      setState({ loading: false, session: null });
      return;
    }

    let cancelled = false;
    setState({ loading: true, session: null });

    const run = () => {
      void resolveOverlaySession(token).then((session) => {
        if (cancelled) return;
        setState((prev) =>
          // Same row, same render. A source that re-rendered on every realtime message would remount
          // the whole board underneath it, which on stream reads as a flicker.
          !prev.loading &&
          prev.session?.roomCode === (session?.roomCode ?? null) &&
          prev.session?.team === (session?.team ?? null) &&
          prev.session?.status === (session?.status ?? null)
            ? prev
            : { loading: false, session }
        );
      });
    };

    resolveRef.current = run;
    run();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const userId = state.session?.userId ?? null;

  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`overlay-seat-${userId}`)
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
  }, [userId]);

  return state;
}
