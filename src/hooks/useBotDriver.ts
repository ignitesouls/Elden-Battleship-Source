import { useEffect, useState } from "react";
import { matchStartedAt, battlePhaseAt, matchTimings } from "../lib/matchTime";
import { pauseInfoAt } from "../lib/matchPause";
import { serverNow } from "../lib/serverTime";
import { nudgeBot } from "../lib/rooms";
import { humans, isBotTier } from "../lib/bot";
import type { RoomState } from "./useRoom";

/**
 * How long to wait before asking again when an ask changed nothing - a realtime update that never
 * arrived, or this clock a second ahead of the server's. Long enough that a stuck room costs four
 * requests a minute, not sixty.
 */
const RETRY_MS = 15_000;

/** A little after the second the bot is due, so this clock being slightly early doesn't waste a call. */
const LATE_MS = 750;

/**
 * Keeps the bot opponent playing: tells the bot function when it is due to place or to fire.
 *
 * Exactly one browser in the room does this - the host while their tab is open, otherwise the
 * earliest-joined person who is - so a room asks once per bot shot rather than once per viewer. The
 * function decides for itself whether the bot really is due (see supabase/functions/bot), so two
 * browsers briefly both thinking they drive, which presence makes possible for a second or two,
 * costs a wasted request and nothing else.
 *
 * Everything is timed off rooms.bot_next_s, which is in MATCH seconds: a pause freezes the match
 * clock, so it holds the bot's next shot back by exactly as long without anything here knowing
 * about pauses beyond "don't ask while stopped".
 */
export function useBotDriver(state: RoomState): void {
  const { room, players, myPlayer, attacks, teamReady, onlinePlayerIds } = state;
  const [tick, setTick] = useState(0);

  const people = humans(players);
  const online = new Set(onlinePlayerIds);
  const host = people.find((p) => p.is_host);
  // Presence hasn't reported yet while the list is empty, which must not read as "the host is gone".
  const hostHere = host && (onlinePlayerIds.length === 0 || online.has(host.id));
  const driver = hostHere
    ? host
    : people.filter((p) => online.has(p.id)).sort((a, b) => a.id.localeCompare(b.id))[0];
  const drives = !!myPlayer && driver?.id === myPlayer.id;

  const hasBot = !!room && isBotTier(room.bot_tier) && room.bot_team != null;
  const botTeam = room?.bot_team ?? null;
  const botReady = teamReady.some((r) => r.team === botTeam && r.ready);
  const startedAt = matchStartedAt(attacks);

  const roomId = room?.id;
  const status = room?.status;
  const nextAt = room?.bot_next_s ?? null;
  const pauseAt = room?.pause_at ?? null;
  const resumeAt = room?.resume_at ?? null;
  const startingSeconds = room?.starting_seconds;
  const prepSeconds = room?.prep_seconds;
  const pauseLog = room?.pause_log;

  useEffect(() => {
    if (!roomId || !hasBot || !drives) return;

    let wait: number | null = null;
    if (status === "placement" && !botReady) {
      wait = 500;
    } else if (status === "battle" && startedAt) {
      const now = serverNow();
      const pauseFields = { pause_at: pauseAt, resume_at: resumeAt, pause_log: pauseLog };
      const pause = pauseInfoAt(pauseFields, now);
      // Stopped: the resume rewrites the room row, which runs this again.
      if (pause.stopped) return;
      const phase = battlePhaseAt(startedAt, now, matchTimings({ starting_seconds: startingSeconds, prep_seconds: prepSeconds }), pause);
      if (!phase) return;
      // Null is a match whose first shot isn't booked yet; the first ask once firing opens books it.
      const due = nextAt ?? 0;
      const seconds = phase.phase === "match" ? due - phase.matchElapsed : phase.countdown + due;
      wait = Math.max(0, seconds * 1000) + LATE_MS;
    }
    if (wait === null) return;

    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      void nudgeBot(roomId).finally(() => {
        if (!cancelled) retry = setTimeout(() => setTick((n) => n + 1), RETRY_MS);
      });
    }, wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (retry) clearTimeout(retry);
    };
  }, [roomId, hasBot, drives, status, botReady, startedAt, nextAt, pauseAt, resumeAt, pauseLog, startingSeconds, prepSeconds, tick]);
}
