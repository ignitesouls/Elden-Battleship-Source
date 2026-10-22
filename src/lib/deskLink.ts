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

/**
 * How long a desk waits, on joining, for another desk on the same stream to tell it the matchup
 * before putting its own on air.
 */
const ASK_FIRST_MS = 1500;

/**
 * The desk's end: sends `state` whenever it changes, and answers any source that says hello.
 *
 * Several desks can share one stream (co-casters - see lib/castDesks), so a desk also LISTENS: a
 * state from another desk is handed to `onAdopt`, and a desk that has just joined asks before it
 * tells, so it picks up what is already on air instead of replacing it with whatever its own browser
 * last remembered. An adopted state is never re-sent - two desks that adopted each other's at the
 * same moment would otherwise trade them back and forth forever.
 */
export function useDeskPublisher(
  userId: string | null | undefined,
  state: DeskState,
  onAdopt?: (state: DeskState) => void,
  /**
   * Whether to put this desk's state on air when nobody answers. True for the owner's own desk; false
   * for a co-caster at somebody else's, whose browser has nothing of that stream's to say - blanking
   * its Starting Soon just for opening the page would be wrong. They still send whatever they type.
   */
  announce = true
): void {
  const latest = useRef(state);
  latest.current = state;
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const adopt = useRef(onAdopt);
  adopt.current = onAdopt;
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  /** False until this desk has heard what is on air, or waited long enough to know nothing is. */
  const settled = useRef(false);
  const adoptedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured || !userId) return;
    settled.current = false;
    const channel = supabase.channel(channelName(userId), { config: { broadcast: { self: false } } });
    channelRef.current = channel;
    let wait: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      if (!settled.current) return;
      void channel.send({ type: "broadcast", event: STATE_EVENT, payload: latest.current });
    };
    channel
      .on("broadcast", { event: HELLO_EVENT }, send)
      .on("broadcast", { event: STATE_EVENT }, ({ payload }) => {
        clearTimeout(wait);
        settled.current = true;
        adoptedKey.current = JSON.stringify(payload);
        adopt.current?.(payload as DeskState);
      })
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") return;
        void channel.send({ type: "broadcast", event: HELLO_EVENT, payload: {} });
        wait = setTimeout(() => {
          settled.current = true;
          if (announceRef.current) send();
        }, ASK_FIRST_MS);
      });
    return () => {
      clearTimeout(wait);
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  const key = JSON.stringify(state);
  useEffect(() => {
    if (!settled.current || key === adoptedKey.current) return;
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
