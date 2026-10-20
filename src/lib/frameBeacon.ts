import { useEffect, useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabase";

/**
 * Which players have the Elden Battleship player frame on their stream right now - so a caster's box
 * can crop their Twitch feed down to the gameplay hole without anybody ticking anything.
 *
 * -- How it knows ---------------------------------------------------------------------------------
 *
 * The player frame scene's "EB Player Frame" source is a browser source with `shutdown` on (see
 * browserSource in lib/obsScene): OBS only runs the page while the source is showing. So while that
 * page is alive, the frame is up on the player's screen, and when they switch to another scene it
 * stops and leaves. While alive it announces its owner on one Realtime presence channel; a caster box
 * listens to that channel and crops the boxes whose player is on it.
 *
 * Presence, not a table: it costs no API request (every REST call is a metered log line), it clears
 * itself when the source stops - a crashed OBS included - and nothing needs tidying afterwards.
 *
 * The announcement is the account id the overlay token already resolved to, nothing more. Anyone
 * could announce someone else's id; the worst that does is crop a caster's box of that player, which
 * the caster sees at once. Not worth a server round trip to prevent.
 */

const CHANNEL = "eb-player-frames";

/** Announce that `userId`'s player frame is showing, for as long as the calling page is mounted. */
export function useFrameBeacon(userId: string | null | undefined): void {
  useEffect(() => {
    if (!isSupabaseConfigured || !userId) return;
    const channel = supabase.channel(CHANNEL, { config: { presence: { key: userId } } });
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") void channel.track({ at: new Date().toISOString() });
    });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId]);
}

/** The account ids whose player frame is showing right now. Empty until presence first reports. */
export function useFramesOnAir(enabled = true): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!isSupabaseConfigured || !enabled) return;
    // A listener only - no key, nothing tracked, so a caster box never shows up as a frame.
    const channel = supabase.channel(CHANNEL);
    const sync = () => {
      const next = new Set(Object.keys(channel.presenceState()));
      // Presence fires sync liberally; only re-render when the set actually changed.
      setIds((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next));
    };
    channel
      .on("presence", { event: "sync" }, sync)
      .on("presence", { event: "join" }, sync)
      .on("presence", { event: "leave" }, sync)
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled]);

  return ids;
}
