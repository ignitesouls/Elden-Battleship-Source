import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

/** Highest a square counter goes. Two digits is all a square has room to print legibly. */
export const MAX_COUNT = 99;

/** How long to let the wheel settle before writing. One spin is a burst of events, not one edit. */
const WRITE_DEBOUNCE_MS = 400;

export interface SquareCountRow {
  player_id: string;
  cell_index: number;
  tally: number;
  /** Which fleet the count belongs to. Selected so the client can sanity-check what RLS sent. */
  team?: number;
}

/** cell index -> player id -> tally. Zero tallies are pruned on the way in. */
export type CountMap = Map<number, Map<string, number>>;

/** team -> that fleet's counts. What a spectator reads, since they belong to no fleet themselves. */
export type TeamCountMap = Map<number, CountMap>;

function localKey(roomCode: string | undefined) {
  return roomCode ? `eb_counts_${roomCode}` : null;
}

function toMap(rows: SquareCountRow[]): CountMap {
  const out: CountMap = new Map();
  for (const r of rows) {
    if (!r.tally) continue;
    const byPlayer = out.get(r.cell_index) ?? new Map<string, number>();
    byPlayer.set(r.player_id, r.tally);
    out.set(r.cell_index, byPlayer);
  }
  return out;
}

/**
 * Tallies resolved from player ids into something a square can print.
 *
 * Shared by the player's board and the spectator's so the two can't order or cap them differently -
 * a caster reading out "Marchbanks has four" has to be looking at the same three chips the fleet is.
 *
 * Mine sorts first and is flagged for the accent colour. With no names on the chips those two things
 * are the whole of "which one is mine", so both matter: first position is where the eye lands, and
 * gold is what it confirms. The rest follow by tally, largest first, so a square capped at three
 * shows the crewmates furthest along rather than whichever ids happen to sort first - and the
 * square's tooltip names everyone regardless.
 *
 * A spectator passes no `myPlayerId`, so nothing is gold and the order is purely by tally.
 */
export function countChips(
  counts: CountMap,
  nickname: (playerId: string) => string,
  myPlayerId?: string
): Map<number, Array<{ tally: number; mine?: boolean; fullName: string }>> {
  const out = new Map<number, Array<{ tally: number; mine?: boolean; fullName: string }>>();
  for (const [cell, byPlayer] of counts) {
    const chips = [];
    for (const [pid, tally] of byPlayer) {
      if (tally <= 0) continue;
      chips.push({ tally, mine: pid === myPlayerId, fullName: nickname(pid) });
    }
    if (chips.length === 0) continue;
    chips.sort((a, b) => Number(b.mine) - Number(a.mine) || b.tally - a.tally);
    out.set(cell, chips);
  }
  return out;
}

/**
 * Per-square tallies, shared with the rest of your fleet.
 *
 * Counts are stored per (player, square) rather than summed per team: who did what is the thing a
 * team divides work with, and one shared integer that two people can both edit is a lost-update
 * race with no way to tell whose number won.
 *
 * Degrades to browser-local storage when the `square_counts` table isn't there yet - see
 * RUN_THESE.sql. That is the whole reason `shared` is part of the return: the site has to be
 * deployable before the migration is applied, and a counter that silently stopped working (or
 * threw) in the gap would be worse than one that is merely private for a day.
 */
export function useSquareCounts({
  roomId,
  roomCode,
  playerId,
  team,
}: {
  roomId: string | undefined;
  roomCode: string | undefined;
  playerId: string | undefined;
  team: number | null | undefined;
}) {
  const [counts, setCounts] = useState<CountMap>(new Map());
  /** Whether tallies are reaching the database. Set by the load probe, corrected by flush(). */
  const [shared, setShared] = useState(false);
  const sharedRef = useRef(false);
  /** A write the database refused for a reason worth showing. Null while everything is fine. */
  const [writeError, setWriteError] = useState<string | null>(null);
  /** Bumped when a write brings us online, to re-read what the crew counted while we were local. */
  const [refetch, setRefetch] = useState(0);

  // Cells edited since the last flush. Held in a ref so a burst of wheel events doesn't
  // re-render once per notch just to remember what still needs writing.
  const dirty = useRef<Set<number>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read inside the debounced flush, which would otherwise close over the counts from whichever
  // render happened to schedule it - i.e. everything but the last notch of a spin.
  const latest = useRef<CountMap>(counts);
  latest.current = counts;

  // Initial load. A failure here is expected rather than exceptional (the table may not exist),
  // so it falls back rather than surfacing an error.
  useEffect(() => {
    // Only the room is needed to ask: the select is scoped by room_id and RLS does the team
    // filtering, so this returns exactly the crew's counts and nobody else's. `team` is still a
    // dependency because switching fleets changes what that policy will hand back.
    if (!roomId) return;
    let cancelled = false;

    (async () => {
      // `team` is selected only so the client can double-check it - RLS is what actually enforces
      // this, but a row for another team arriving at all would mean the policy wasn't doing its job,
      // and drawing it would be the one visible symptom. See the filter in mergeRow below.
      const { data, error } = await supabase
        .from("square_counts")
        .select("player_id, cell_index, tally, team")
        .eq("room_id", roomId);

      if (cancelled) return;

      if (error) {
        sharedRef.current = false;
        setShared(false);
        try {
          const raw = localStorage.getItem(localKey(roomCode) ?? "");
          const pairs: [number, number][] = raw ? JSON.parse(raw) : [];
          setCounts(toMap(pairs.map(([cell, tally]) => ({ player_id: playerId ?? "me", cell_index: cell, tally }))));
        } catch {
          setCounts(new Map());
        }
        return;
      }

      sharedRef.current = true;
      setShared(true);
      const rows = ((data as SquareCountRow[]) ?? []).filter((r) => r.team === undefined || r.team === team);
      setCounts(toMap(rows));
    })();

    return () => {
      cancelled = true;
    };
    // `refetch` re-runs this after a write brings us online - see flush(). It is only ever bumped
    // there, and this effect never bumps it, so there is no loop.
  }, [roomId, roomCode, playerId, team, refetch]);

  /**
   * Live updates from crewmates.
   *
   * Rows arrive one at a time and are merged in place; a tally of 0 is a deletion, which is exactly
   * why zeroes are WRITTEN rather than the row being removed - Postgres only replicates primary-key
   * columns on DELETE, so a real delete would never arrive through this filter.
   *
   * The `team` check is belt and braces. Realtime applies the same RLS policy per subscriber, so an
   * opponent should never be sent these rows in the first place; this is the cheap second line that
   * means a policy regression shows up as nothing on screen rather than as the other team reading
   * your working. It is NOT the security boundary - RLS is. See scripts/check-square-counts.mjs.
   */
  useEffect(() => {
    if (!roomId || !shared) return;

    const channel = supabase
      .channel(`square_counts:${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "square_counts", filter: `room_id=eq.${roomId}` },
        (payload) => {
          const row = payload.new as SquareCountRow | null;
          if (!row?.player_id) return;
          if (row.team !== undefined && row.team !== team) return;
          setCounts((prev) => {
            const next = new Map(prev);
            const byPlayer = new Map(next.get(row.cell_index) ?? []);
            if (row.tally > 0) byPlayer.set(row.player_id, row.tally);
            else byPlayer.delete(row.player_id);
            if (byPlayer.size === 0) next.delete(row.cell_index);
            else next.set(row.cell_index, byPlayer);
            return next;
          });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [roomId, shared, team]);

  /** Writes this player's own numbers to browser storage. Flattens to pairs - only ever mine. */
  const writeLocal = useCallback(() => {
    const key = localKey(roomCode);
    if (!key) return;
    const pairs: [number, number][] = [];
    for (const [cell, byPlayer] of latest.current) {
      const mine = byPlayer.get(playerId ?? "me");
      if (mine) pairs.push([cell, mine]);
    }
    try {
      localStorage.setItem(key, JSON.stringify(pairs));
    } catch {
      // Private mode / quota. Not worth surfacing over an annotation.
    }
  }, [roomCode, playerId]);

  /**
   * Pushes the dirty cells to the database, falling back to browser storage only if that fails.
   *
   * TRIES THE WRITE FIRST rather than consulting the load-time probe, which is the whole fix here.
   * The probe used to be the decision: one failed select on mount latched `shared` false for the
   * life of the page, and every flush after that went quietly to localStorage. So every client that
   * had the room open before the `square_counts` table existed kept counting into its own browser
   * forever - the table went in, the policies went in, the checks passed, and the live database
   * still had zero rows in it, because not one of those tabs ever asked again.
   *
   * Attempting the write instead makes it self-healing: the first successful upsert after the table
   * appears flips the client to shared and re-reads what the crew has been doing meanwhile. And a
   * write that genuinely IS refused now surfaces, rather than being dropped on the floor by a
   * `void` - which is why it took a database query to find out this was broken at all.
   */
  const flush = useCallback(async () => {
    timer.current = null;
    const cells = [...dirty.current];
    dirty.current.clear();
    if (cells.length === 0) return;

    if (roomId && playerId && team !== null && team !== undefined) {
      const rows = cells.map((cell) => ({
        room_id: roomId,
        player_id: playerId,
        team,
        cell_index: cell,
        tally: latest.current.get(cell)?.get(playerId) ?? 0,
        updated_at: new Date().toISOString(),
      }));
      const { error } = await supabase
        .from("square_counts")
        .upsert(rows, { onConflict: "room_id,player_id,cell_index" });

      if (!error) {
        setWriteError(null);
        // First write to land after a failed probe: come online, and pull in whatever the rest of
        // the fleet has counted while this tab was talking to itself.
        if (!sharedRef.current) {
          sharedRef.current = true;
          setShared(true);
          setRefetch((n) => n + 1);
        }
        return;
      }

      // A missing table is the expected, unremarkable case (see RUN_THESE.sql) and stays quiet;
      // anything else is a policy refusing a legitimate write, and somebody needs to know.
      sharedRef.current = false;
      setShared(false);
      setWriteError(error.code === "PGRST205" ? null : error.message);
    }

    writeLocal();
  }, [roomId, playerId, team, writeLocal]);

  /**
   * Nudge my own tally on one square. Optimistic: the board moves now, the write catches up.
   *
   * Reads and writes `latest` rather than using a functional setState, because one flick of a wheel
   * is a burst of events that all land before React re-renders - each has to see the last one's
   * result, and the debounced write has to see the final value rather than whichever render
   * happened to schedule it.
   */
  const bump = useCallback(
    (cell: number, delta: number) => {
      const me = playerId ?? "me";
      const current = latest.current.get(cell)?.get(me) ?? 0;
      const value = Math.max(0, Math.min(MAX_COUNT, current + delta));
      if (value === current) return; // already clamped; don't churn a write out of nothing

      const next = new Map(latest.current);
      const byPlayer = new Map(next.get(cell) ?? []);
      if (value === 0) byPlayer.delete(me);
      else byPlayer.set(me, value);
      if (byPlayer.size === 0) next.delete(cell);
      else next.set(cell, byPlayer);

      latest.current = next;
      setCounts(next);

      dirty.current.add(cell);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), WRITE_DEBOUNCE_MS);
    },
    [playerId, flush]
  );

  /** Drops every count of MINE. Crewmates' stay - they aren't yours to clear. */
  const clear = useCallback(() => {
    const me = playerId ?? "me";
    const mine = [...latest.current].filter(([, byPlayer]) => byPlayer.has(me)).map(([cell]) => cell);
    if (mine.length === 0) return;

    const next = new Map(latest.current);
    for (const cell of mine) {
      const byPlayer = new Map(next.get(cell) ?? []);
      byPlayer.delete(me);
      if (byPlayer.size === 0) next.delete(cell);
      else next.set(cell, byPlayer);
    }
    latest.current = next;
    setCounts(next);

    if (sharedRef.current && roomId && playerId) {
      void supabase.from("square_counts").delete().eq("room_id", roomId).eq("player_id", playerId);
    } else {
      const key = localKey(roomCode);
      if (key) {
        try {
          localStorage.removeItem(key);
        } catch {
          // As above.
        }
      }
    }
  }, [playerId, roomId, roomCode]);

  // Don't strand a spin that was still settling when the board unmounted.
  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void flush();
      }
    };
  }, [flush]);

  /** How many squares carry a count of mine, for the "clear notes" button. */
  const mineCount = (() => {
    const me = playerId ?? "me";
    let n = 0;
    for (const byPlayer of counts.values()) if (byPlayer.has(me)) n++;
    return n;
  })();

  return { counts, bump, clear, shared, mineCount, writeError };
}

/**
 * Every fleet's tallies, for a spectator. Read-only - there is no fleet to write one onto.
 *
 * A caster following a match needs the working-out as much as the shots do: "they're two of three
 * into the tunnels" is the thing that explains why a fleet is sitting on a square rather than
 * firing. Without this the counters were invisible from the booth even though the players could see
 * them on their own boards.
 *
 * Whether the rows arrive at all is the "square_counts select by spectator" policy's decision, not
 * this hook's - a spectator is a player row in the room with team null, and that policy is what
 * hands them every fleet's counts instead of one fleet's. So this asks for the room and sorts
 * whatever comes back by team, exactly as the player's hook trusts RLS to have already filtered.
 *
 * Silent on failure, like the player's hook: the table may not exist yet (see RUN_THESE.sql), and a
 * spectator page that threw over an annotation would be a worse answer than one with no chips on it.
 */
export function useSpectatorCounts(roomId: string | undefined): TeamCountMap {
  const [byTeam, setByTeam] = useState<TeamCountMap>(new Map());

  useEffect(() => {
    if (!roomId) {
      setByTeam(new Map());
      return;
    }
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("square_counts")
        .select("player_id, cell_index, tally, team")
        .eq("room_id", roomId);

      if (cancelled) return;
      if (error) {
        setByTeam(new Map());
        return;
      }

      const grouped = new Map<number, SquareCountRow[]>();
      for (const row of (data as SquareCountRow[]) ?? []) {
        if (typeof row.team !== "number") continue;
        const rows = grouped.get(row.team) ?? [];
        rows.push(row);
        grouped.set(row.team, rows);
      }
      setByTeam(new Map([...grouped].map(([team, rows]) => [team, toMap(rows)])));
    })();

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  /**
   * Live updates from every fleet at once.
   *
   * Subscribed unconditionally rather than behind a "did the table answer" flag like the player's
   * hook, which needs one because it has a local-storage fallback to choose between. There is no
   * fallback here - a spectator has no counts of their own to fall back TO - so a socket that never
   * delivers anything costs nothing beyond itself.
   */
  useEffect(() => {
    if (!roomId) return;

    const channel = supabase
      .channel(`spectate_counts:${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "square_counts", filter: `room_id=eq.${roomId}` },
        (payload) => {
          const row = payload.new as SquareCountRow | null;
          if (!row?.player_id || typeof row.team !== "number") return;
          const team = row.team;
          setByTeam((prev) => {
            const next = new Map(prev);
            const cells = new Map(next.get(team) ?? []);
            const byPlayer = new Map(cells.get(row.cell_index) ?? []);
            // A tally of 0 is a deletion - see the note on the player's subscription for why zeroes
            // are written rather than the row being removed.
            if (row.tally > 0) byPlayer.set(row.player_id, row.tally);
            else byPlayer.delete(row.player_id);
            if (byPlayer.size === 0) cells.delete(row.cell_index);
            else cells.set(row.cell_index, byPlayer);
            next.set(team, cells);
            return next;
          });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [roomId]);

  return byTeam;
}
