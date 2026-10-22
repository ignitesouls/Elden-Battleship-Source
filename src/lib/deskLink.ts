import { useEffect, useRef, useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabase";

/**
 * The caster desk's link to its sources that has nothing to do with a room - so far, the matchup on
 * the "Starting Soon" screen.
 *
 * -- Why not the cast channel ------------------------------------------------------------------
 *
 * lib/overlayCast's channel is keyed on the room code, which is right for everything about a match.
 * But "Starting Soon: A vs. B" is on screen BEFORE the match - often before anyone has made the room -
 * and a channel keyed on a room that doesn't exist yet carries nothing. So this one is keyed on the
 * caster's own account (the id their overlay token resolves to), which exists the whole time.
 *
 * -- What travels ----------------------------------------------------------------------------------
 *
 * The whole state every time it changes, desk -> sources, plus HELLO, source -> desk: a source that
 * has just started holds nothing and asks; the desk answers with what it has. No heartbeat - the text
 * changes when a caster types and not otherwise.
 *
 * Anyone who knew a caster's account id could send on this topic. The worst it does is change the
 * words on their Starting Soon screen, which the caster sees at once on their own preview. Not worth
 * a server round trip to prevent - the same judgement lib/frameBeacon makes.
 */

const STATE_EVENT = "state";
const HELLO_EVENT = "hello";

const channelName = (userId: string) => `desk:${userId}`;

export interface DeskState {
  /** The two sides of the matchup, as the caster typed them. Empty strings draw as blanks. */
  matchup: [string, string];
}

/** The desk's end: sends `state` whenever it changes, and answers any source that says hello. */
export function useDeskPublisher(userId: string | null | undefined, state: DeskState): void {
  const latest = useRef(state);
  latest.current = state;
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured || !userId) return;
    const channel = supabase.channel(channelName(userId), { config: { broadcast: { self: false } } });
    channelRef.current = channel;
    const send = () =>
      void channel.send({ type: "broadcast", event: STATE_EVENT, payload: latest.current });
    channel.on("broadcast", { event: HELLO_EVENT }, send).subscribe((status) => {
      if (status === "SUBSCRIBED") send();
    });
    return () => {
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  const key = JSON.stringify(state);
  useEffect(() => {
    void channelRef.current?.send({ type: "broadcast", event: STATE_EVENT, payload: latest.current });
  }, [key]);
}

/** A source's end: the desk's latest state, or null until a desk has said anything. */
export function useDeskState(userId: string | null | undefined): DeskState | null {
  const [state, setState] = useState<DeskState | null>(null);
  useEffect(() => {
    if (!isSupabaseConfigured || !userId) return;
    const channel = supabase.channel(channelName(userId), { config: { broadcast: { self: false } } });
    channel
      .on("broadcast", { event: STATE_EVENT }, ({ payload }) => setState(payload as DeskState))
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void channel.send({ type: "broadcast", event: HELLO_EVENT, payload: {} });
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId]);
  return state;
}
