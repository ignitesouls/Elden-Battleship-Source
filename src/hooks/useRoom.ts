import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, ensureSignedIn } from "../lib/supabase";
import { getStoredPlayerId, storePlayerId } from "../lib/playerSession";
import {
  resolveAttack,
  allShipsSunk,
  activeTeams,
  eliminatedTeamsFromAttacks,
  initialHitsRemaining,
} from "../lib/battleshipLogic";
import { normalizeRoomCode } from "../lib/roomCode";
import { resetOwnTeamState } from "../lib/rooms";
import { setTeamNameOverrides } from "../lib/teamColors";
import type { DeepHide } from "../lib/deepWater";
import type { Room, Player, Fleet, Attack, TeamReady } from "../types/battleship";

export interface RoomState {
  loading: boolean;
  error: string | null;
  room: Room | null;
  players: Player[];
  myPlayer: Player | null;
  myFleet: Fleet | null;
  attacks: Attack[];
  teamReady: TeamReady[];
  /**
   * The hiding places in this room's water that have been fired at (see lib/deepWater.ts).
   *
   * Never the whole set: RLS hides a row until a shot at its square resolves, so this grows one
   * square at a time and a match nobody has found anything in reads as empty. Also empty on a
   * project that hasn't run the deep_hides migration, which is why nothing here is checked.
   */
  deepHides: DeepHide[];
  /**
   * Every team's fleet that RLS is willing to show us: all of them while watching as a
   * spectator, and all of them once the match is finished (for the post-match report). Empty
   * for a player mid-match, who may only ever read their own team's row.
   */
  revealedFleets: Fleet[];
  /**
   * Player ids currently connected, via Realtime Presence. `players` rows persist whether or
   * not a tab is open, so this is the only way to tell who is actually here - which drives the
   * roster's live dots and the "host has gone dark" takeover prompt.
   */
  onlinePlayerIds: string[];
  /** Realtime channel health. "offline" means live updates have stopped arriving. */
  connection: "connecting" | "online" | "offline";
}

const initialState: RoomState = {
  loading: true,
  error: null,
  room: null,
  players: [],
  myPlayer: null,
  myFleet: null,
  attacks: [],
  teamReady: [],
  deepHides: [],
  revealedFleets: [],
  onlinePlayerIds: [],
  connection: "connecting",
};

/**
 * Row-by-row shallow equality, used to decide whether a refetch is worth a render.
 *
 * Every table this compares is flat scalar columns, so a shallow compare is a real compare - and
 * it is the cheap half of what makes resync() safe to call speculatively. Without it, each
 * re-read would hand React four brand-new arrays and repaint the whole match screen: both boards,
 * every marker, the log and the rosters. With it, the overwhelmingly common "we missed nothing"
 * case costs four indexed selects and not a single render. That matters more here than almost
 * anywhere else in the app, because this hook sits at the very top of the match tree - the same
 * reason the battle clock was moved out of it (see hooks/useBattlePhase.ts).
 *
 * Positional, not keyed: both sides come from the same ordered query. Rows sharing a created_at -
 * which auto-fire produces, one per defending fleet - could in principle come back in a different
 * order and be read as a change. The cost of that is one wasted render on a resync, so it isn't
 * worth a tiebreaker.
 */
function sameRows<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as Record<string, unknown>;
    const y = b[i] as Record<string, unknown>;
    const keys = Object.keys(x);
    if (keys.length !== Object.keys(y).length) return false;
    for (const key of keys) if (x[key] !== y[key]) return false;
  }
  return true;
}

/**
 * Upsert one attack row into the log, keyed by id.
 *
 * Shared by the realtime handler and by the resolver further down, which now adopts the row it
 * settled rather than waiting to be told about it. That second caller is why the no-change case
 * returns `prev` by identity: it re-reads rows it usually already has, and this hook sits at the
 * top of the match tree, so handing React a new array every time would repaint both boards, every
 * marker, the log and the rosters for nothing.
 */
function withAttack(prev: RoomState, row: Attack): RoomState {
  const attacks = [...prev.attacks];
  const idx = attacks.findIndex((a) => a.id === row.id);
  if (idx >= 0) {
    if (sameRows([attacks[idx]], [row])) return prev;
    attacks[idx] = row;
  } else {
    attacks.push(row);
  }
  return { ...prev, attacks };
}

export function useRoom(code: string | undefined) {
  const [state, setState] = useState<RoomState>(initialState);

  /**
   * The room's authoritative re-read, published for the visibility handler further down.
   *
   * A ref because resync() closes over both the room id and the subscription effect's `cancelled`
   * flag, so it can't be lifted out of that effect without dragging both along with it.
   */
  const resyncRef = useRef<(() => Promise<void>) | null>(null);

  const patch = useCallback((partial: Partial<RoomState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  // Initial load + realtime subscriptions
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    const channels: ReturnType<typeof supabase.channel>[] = [];

    (async () => {
      try {
        const userId = await ensureSignedIn();

        // Normalized so a hand-typed or shared-with-spaces URL still resolves to the room.
        const lookup = normalizeRoomCode(code);
        const { data: room, error: roomErr } = await supabase
          .from("rooms")
          .select()
          .eq("code", lookup)
          .maybeSingle();
        if (roomErr) throw roomErr;
        // A code that matches nothing is NOT an error - it's the ordinary end of a room's life.
        // Rooms are pruned an hour after they go quiet, so every stale link, every bookmark and
        // every "back to the room" in the top bar eventually lands here.
        //
        // This used to throw, which sent the page down the `state.error` branch: a bare line of red
        // text with no way out of it. The room-gone panel the page already had (see Room.tsx) was
        // unreachable for the entire case it was written for, and Room's roomGone check - the thing
        // that forgets the room so the top bar stops offering it - could never fire either, so the
        // dead link survived every visit. `error` is left for the failures that really are failures:
        // no network, no database, a rejected read.
        if (!room) {
          if (!cancelled) patch({ loading: false, error: null, room: null });
          return;
        }
        if (cancelled) return;

        const { data: players, error: playersErr } = await supabase
          .from("players")
          .select()
          .eq("room_id", room.id);
        if (playersErr) throw playersErr;

        // Match on user_id first, falling back to the stored player id. The auth session is the
        // real identity; the localStorage id is just a cache. Relying on the cache alone meant
        // that clearing it (while the auth session survived) dropped you back to the join form
        // as a stranger, even though your row - and your fleet - were sitting right there.
        const storedId = getStoredPlayerId(room.code);
        const myPlayer =
          (players ?? []).find((p) => p.user_id === userId) ??
          (players ?? []).find((p) => p.id === storedId) ??
          null;
        if (myPlayer) storePlayerId(room.code, myPlayer.id);

        let myFleet: Fleet | null = null;
        let revealedFleets: Fleet[] = [];
        if (myPlayer?.team !== null && myPlayer?.team !== undefined) {
          const { data: fleet } = await supabase
            .from("fleets")
            .select()
            .eq("room_id", room.id)
            .eq("team", myPlayer.team)
            .maybeSingle();
          myFleet = (fleet as Fleet) ?? null;
        } else if (myPlayer) {
          // Spectator: allowed to read every fleet in this room (see the "fleets select by
          // spectator" policy). Returns [] if that policy hasn't been applied yet, which just
          // means ship overlays stay hidden rather than the page erroring.
          const { data: fleets } = await supabase.from("fleets").select().eq("room_id", room.id);
          revealedFleets = (fleets as Fleet[]) ?? [];
        }

        const { data: attacks, error: attacksErr } = await supabase
          .from("attacks")
          .select()
          .eq("room_id", room.id)
          .order("created_at", { ascending: true });
        if (attacksErr) throw attacksErr;

        const { data: teamReady, error: teamReadyErr } = await supabase
          .from("team_ready")
          .select()
          .eq("room_id", room.id);
        if (teamReadyErr) throw teamReadyErr;

        // Read here as well as in the effect below, so that `loading: false` means the water has
        // been read too. The post-match report archives itself the moment it mounts, and a recap
        // that mounted before the first read landed would file a match with its deep-water honors
        // missing - permanently, since the archive dedupes and never writes that match again.
        //
        // Unchecked, unlike the reads above: an un-migrated project has no such table, and a room
        // that cannot load at all is a far worse outcome than a match with nothing hiding in it.
        const { data: deepHides } = await supabase.from("deep_hides").select().eq("room_id", room.id);

        if (cancelled) return;
        patch({
          loading: false,
          error: null,
          room: room as Room,
          players: (players as Player[]) ?? [],
          myPlayer,
          myFleet,
          revealedFleets,
          attacks: (attacks as Attack[]) ?? [],
          teamReady: (teamReady as TeamReady[]) ?? [],
          deepHides: (deepHides ?? []).map((row) => ({
            cellIndex: row.cell_index,
            creature: row.creature,
            decoy: row.decoy ?? false,
          })),
        });

        const roomId = room.id;

        /**
         * Fleet and attack rows arriving from realtime.
         *
         * Hoisted out of the channel chain because each is now registered TWICE, once for INSERT
         * and once for UPDATE, rather than once for "*". Realtime bills per message delivered to
         * per client, and DELETE is the expensive event here: resetMatch() clears the whole attack
         * log in one statement, so a 150-shot match ended in a six-player room was broadcasting
         * ~900 messages to tell everyone about rows they were about to discard anyway.
         *
         * Neither handler could do anything useful with a DELETE regardless - payload.new is an
         * empty object on delete, so the fleet one was a latent bug waiting for the pruner to fire
         * while somebody still had the page open.
         */
        const onFleetChange = (payload: { new: unknown }) => {
          const row = payload.new as Fleet;
          setState((prev) => {
            if (prev.myPlayer?.team === row.team) {
              return { ...prev, myFleet: row };
            }
            // Spectators track every team's fleet so ship overlays update live as each
            // team places and loses ships.
            if (prev.myPlayer && prev.myPlayer.team === null) {
              const revealedFleets = [...prev.revealedFleets];
              const idx = revealedFleets.findIndex((f) => f.team === row.team);
              if (idx >= 0) revealedFleets[idx] = row;
              else revealedFleets.push(row);
              return { ...prev, revealedFleets };
            }
            return prev;
          });
        };

        const onAttackChange = (payload: { new: unknown }) => {
          setState((prev) => withAttack(prev, payload.new as Attack));
        };

        /**
         * Re-reads everything the realtime channel may have missed.
         *
         * Defined before the channel that calls it, and deliberately cheap to call on spec:
         * overlapping calls collapse into the one already in flight, and a read that finds nothing
         * new returns the previous arrays by identity so React bails out of the render entirely.
         * Both properties exist so that the callers below can be blunt about when to re-read
         * rather than clever, because every "clever" gate is a way to stay stale.
         */
        let inFlight: Promise<void> | null = null;

        function resync(): Promise<void> {
          inFlight ??= readEverything().finally(() => {
            inFlight = null;
          });
          return inFlight;
        }

        async function readEverything() {
          const [{ data: freshPlayers }, { data: freshAttacks }, { data: freshReady }, { data: freshRoom }] =
            await Promise.all([
              supabase.from("players").select().eq("room_id", roomId),
              supabase.from("attacks").select().eq("room_id", roomId).order("created_at", { ascending: true }),
              supabase.from("team_ready").select().eq("room_id", roomId),
              supabase.from("rooms").select().eq("id", roomId).maybeSingle(),
            ]);
          if (cancelled) return;
          setState((prev) => {
            const room = (freshRoom as Room) ?? prev.room;
            const players = (freshPlayers as Player[]) ?? prev.players;
            const attacks = (freshAttacks as Attack[]) ?? prev.attacks;
            const teamReady = (freshReady as TeamReady[]) ?? prev.teamReady;

            // Stringified rather than shallow-compared: `rooms` carries ship_defs and board_perm,
            // which come back as fresh arrays every read and would report a change on every pass.
            // It's one small object, only on a resync.
            const roomSame = JSON.stringify(room) === JSON.stringify(prev.room);
            const playersSame = sameRows(players, prev.players);
            const attacksSame = sameRows(attacks, prev.attacks);
            const readySame = sameRows(teamReady, prev.teamReady);
            if (roomSame && playersSame && attacksSame && readySame) return prev;

            return {
              ...prev,
              room: roomSame ? prev.room : room,
              players: playersSame ? prev.players : players,
              attacks: attacksSame ? prev.attacks : attacks,
              teamReady: readySame ? prev.teamReady : teamReady,
            };
          });
        }

        resyncRef.current = resync;

        channels.push(
          supabase
            .channel(`room-${roomId}`)
            // UPDATE only: a room is never inserted while we're already watching it, and on DELETE
            // payload.new is {} - so "*" meant the pruner could quietly replace the entire room
            // object with an empty one.
            .on(
              "postgres_changes",
              { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
              (payload) => {
                const next = payload.new as Room;
                setState((prev) => {
                  // Returning to the lobby is how we now learn the attack log was wiped.
                  // resetMatch() deletes every attack row, and we deliberately no longer listen
                  // for those deletes - but the log MUST still be dropped here, because a
                  // surviving match-start marker would make the next match's clock count from
                  // the previous one.
                  const returnedToLobby = prev.room?.status !== "lobby" && next.status === "lobby";
                  return returnedToLobby
                    ? { ...prev, room: next, attacks: [] }
                    : { ...prev, room: next };
                });
              }
            )
            .on(
              "postgres_changes",
              { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomId}` },
              (payload) => {
                setState((prev) => {
                  const players = [...prev.players];
                  const storedId = getStoredPlayerId(prev.room?.code ?? code);
                  let myPlayer = prev.myPlayer;

                  if (payload.eventType === "DELETE") {
                    const removedId = (payload.old as Player).id;
                    const idx = players.findIndex((p) => p.id === removedId);
                    if (idx >= 0) players.splice(idx, 1);
                    // Was it my own row? (e.g. kicked by the host) - clear it rather than
                    // keeping a stale reference to a player row that no longer exists.
                    if (removedId === storedId) myPlayer = null;
                  } else {
                    const row = payload.new as Player;
                    const idx = players.findIndex((p) => p.id === row.id);
                    if (idx >= 0) players[idx] = row;
                    else players.push(row);
                    if (row.id === storedId) myPlayer = row;
                  }

                  return { ...prev, players, myPlayer };
                });
              }
            )
            .on(
              "postgres_changes",
              { event: "INSERT", schema: "public", table: "fleets", filter: `room_id=eq.${roomId}` },
              onFleetChange
            )
            .on(
              "postgres_changes",
              { event: "UPDATE", schema: "public", table: "fleets", filter: `room_id=eq.${roomId}` },
              onFleetChange
            )
            // The expensive one, and the reason for this whole split. A shot writes one row per
            // opposing team and each is then resolved, so attacks already dominate the message
            // bill - and clearing the log at the end of a match was broadcasting one DELETE per
            // row to every client on top of that. The lobby transition above replaces it.
            .on(
              "postgres_changes",
              { event: "INSERT", schema: "public", table: "attacks", filter: `room_id=eq.${roomId}` },
              onAttackChange
            )
            .on(
              "postgres_changes",
              { event: "UPDATE", schema: "public", table: "attacks", filter: `room_id=eq.${roomId}` },
              onAttackChange
            )
            .on(
              "postgres_changes",
              { event: "*", schema: "public", table: "team_ready", filter: `room_id=eq.${roomId}` },
              (payload) => {
                setState((prev) => {
                  if (payload.eventType === "DELETE") {
                    const removed = payload.old as TeamReady;
                    return { ...prev, teamReady: prev.teamReady.filter((t) => t.team !== removed.team) };
                  }
                  const teamReady = [...prev.teamReady];
                  const row = payload.new as TeamReady;
                  const idx = teamReady.findIndex((t) => t.team === row.team);
                  if (idx >= 0) teamReady[idx] = row;
                  else teamReady.push(row);
                  return { ...prev, teamReady };
                });
              }
            )
            .subscribe((status) => {
              // A dropped channel used to be completely silent: the board simply stopped
              // updating and players assumed the game had frozen. Surface it, and re-read
              // everything on recovery, because any change that happened while we were away
              // was never replayed to us.
              if (cancelled) return;
              if (status === "SUBSCRIBED") {
                // Re-read on EVERY join, including the first one, and not only when we'd first
                // noticed going offline.
                //
                // The offline gate went first: it assumed a lost connection always announces
                // itself, and it doesn't - phoenix skips the error callback for a channel that is
                // already errored or closed, so a socket that dies quietly and comes back leaves
                // `connection` on "online" and every row that landed in the gap stays missing
                // until the page is reloaded.
                //
                // The FIRST-join gate went next, and it was the same mistake one step earlier. It
                // assumed the initial read above already held everything, but that read runs
                // before the websocket has even connected, so anything committed between the
                // select and the channel joining is lost permanently - there is no replay. That
                // window is where a shot gets stranded on "...": the row is read while it is still
                // pending and the UPDATE that settles it arrives during the handshake. Auto-fire
                // is what made that routine rather than theoretical, because the edge function
                // inserts and resolves back to back, so the two are milliseconds apart instead of
                // however long a human takes to answer.
                //
                // resync() no-ops when nothing changed, so being blunt here is close to free.
                void resync();
                setState((prev) => (prev.connection === "online" ? prev : { ...prev, connection: "online" }));
              } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                setState((prev) => (prev.connection === "offline" ? prev : { ...prev, connection: "offline" }));
              }
            })
        );

      } catch (e) {
        if (!cancelled) patch({ loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();

    return () => {
      cancelled = true;
      resyncRef.current = null;
      channels.forEach((c) => supabase.removeChannel(c));
    };
  }, [code, patch]);

  /**
   * Re-read the room whenever the tab comes back to the foreground.
   *
   * -- Why a backgrounded tab goes stale in the first place -----------------------------------
   *
   * Supabase stops refreshing the access token while the tab is hidden - auth-js does this
   * deliberately, so that several tabs can't race each other through a rotating refresh token.
   * The access token lasts an hour (supabase/config.toml, jwt_expiry). Realtime validates that
   * token per channel, so a tab left hidden long enough loses its channel, and the rejoin that
   * follows presents the same expired token and fails just as well. The board freezes, and no
   * amount of waiting fixes it: the only thing that restarts the token ticker is the tab
   * becoming visible again.
   *
   * That was survivable while firing meant clicking, because a player who wanted to shoot was
   * already looking at the page. Auto-marking removed the reason to ever come back, so a player
   * now spends an entire match hidden - the one state this was never exercised in.
   *
   * -- Why this is enough --------------------------------------------------------------------
   *
   * A plain PostgREST read is itself what un-sticks the token: supabase-js resolves the session
   * before every request and refreshes it if it has expired, which emits TOKEN_REFRESHED, which
   * hands realtime the new token and lets the channel rejoin. So re-reading here repairs the
   * data AND the connection, without reaching into auth-js's own visibility handling to countermand
   * it - which would put the rotating-refresh-token race back on the table.
   *
   * Nothing is fetched while hidden. The player isn't looking, live shots are landing in the
   * database regardless (auto-marking runs server-side and never involves the browser), and
   * polling a background tab is exactly the cost this is supposed to avoid.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void resyncRef.current?.();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Fetch/refetch myFleet whenever myPlayer's team changes. The initial-load effect only
  // fetches it once at mount, and the fleets realtime subscription only updates it if a
  // change happens to arrive *after* myPlayer.team is already set to match - relying on
  // that ordering caused fleets to never load when a player picked a team after joining.
  useEffect(() => {
    const room = state.room;
    const team = state.myPlayer?.team;
    if (!room || team === null || team === undefined) return;
    if (state.myFleet?.team === team) return;

    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("fleets").select().eq("room_id", room.id).eq("team", team).maybeSingle();
      if (!cancelled && data) patch({ myFleet: data as Fleet });
    })();
    return () => {
      cancelled = true;
    };
  }, [state.room, state.myPlayer?.team, state.myFleet?.team, patch]);

  /**
   * Re-read the water every time a shot resolves on a square nobody had resolved one on before.
   *
   * A `deep_hides` row becomes readable when an ATTACK resolves, not when the row itself changes -
   * the row was written before the match started and never touches again. Realtime can only push
   * changes to the table it is watching, so there is no subscription that could deliver this, and
   * polling would be reading a table that is usually static. Firing on the count of squares with a
   * resolved shot is exactly the trigger: it ticks once per newly-searched square, which is the only
   * event that can uncover anything, and it drops to zero on a reset so the next match starts blind.
   */
  const deepRoomId = state.room?.id;
  const searchedCells = new Set(
    state.attacks.filter((a) => a.cell_index >= 0 && a.result !== "pending").map((a) => a.cell_index)
  ).size;
  useEffect(() => {
    if (!deepRoomId) return;

    let cancelled = false;
    (async () => {
      // Unchecked: an un-migrated project has no such table, and the only consequence is a match
      // with nothing hiding in it.
      const { data } = await supabase.from("deep_hides").select().eq("room_id", deepRoomId);
      if (cancelled) return;
      const hides: DeepHide[] = (data ?? []).map((row) => ({
        cellIndex: row.cell_index,
        creature: row.creature,
        decoy: row.decoy ?? false,
      }));
      setState((prev) => (prev.room?.id === deepRoomId ? { ...prev, deepHides: hides } : prev));
    })();
    return () => {
      cancelled = true;
    };
  }, [deepRoomId, searchedCells]);

  // Resync everything whenever the match changes phase.
  //
  // Realtime DELETEs on `attacks` never arrive: the client filters that channel by room_id, but
  // Postgres only replicates primary-key columns for a DELETE, and `attacks`' PK is just `id`.
  // So clearing the attack log on reset updated the database while every browser kept rendering
  // the previous match's hits. Rather than depend on replication for removals, re-read the
  // authoritative state on each phase change - it happens a handful of times per match.
  const lastStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const room = state.room;
    if (!room) return;
    if (lastStatusRef.current === room.status) return;
    lastStatusRef.current = room.status;

    let cancelled = false;
    (async () => {
      const [{ data: attacks }, { data: teamReady }] = await Promise.all([
        supabase.from("attacks").select().eq("room_id", room.id).order("created_at", { ascending: true }),
        supabase.from("team_ready").select().eq("room_id", room.id),
      ]);
      if (cancelled) return;
      patch({ attacks: (attacks as Attack[]) ?? [], teamReady: (teamReady as TeamReady[]) ?? [] });

      const team = state.myPlayer?.team;
      if (team !== null && team !== undefined) {
        const { data: fleet } = await supabase
          .from("fleets")
          .select()
          .eq("room_id", room.id)
          .eq("team", team)
          .maybeSingle();
        if (!cancelled && fleet) patch({ myFleet: fleet as Fleet });
      }

      // Spectators can always see every fleet; players can once the match is over (the
      // post-match reveal policy). Re-read here rather than on mount because the reveal only
      // becomes readable at the exact moment status flips to 'finished'.
      if (state.myPlayer && (team === null || team === undefined || room.status === "finished")) {
        const { data: fleets } = await supabase.from("fleets").select().eq("room_id", room.id);
        if (!cancelled) patch({ revealedFleets: (fleets as Fleet[]) ?? [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.room, state.myPlayer?.team, patch]);

  // Self-heal on match reset. RLS scopes fleet/ready writes to the owning team, so the host
  // physically cannot clear everyone else's board - each client clears its own instead as soon
  // as it sees the room back in 'lobby' with stale data still on its fleet.
  const resettingRef = useRef(false);
  useEffect(() => {
    const room = state.room;
    const myFleet = state.myFleet;
    const team = state.myPlayer?.team;
    if (!room || !myFleet || team === null || team === undefined) return;
    if (room.status !== "lobby") return;

    // The host can now change board size and fleet from the lobby, which leaves every existing
    // fleet row sized for the old settings. submitPlacement() rewrites the grids but NOT
    // ship_hits_remaining, so a stale row would resolve hits against the previous ship list -
    // an Armada fleet with five counters instead of seven never finishes sinking.
    //
    // Compared VALUE BY VALUE, not by length. Two presets can field the same number of ships at
    // different sizes, and on the small boards they usually do: every 5x5 fleet is three hulls, so
    // switching Classic to Armada turns [3,2,2] into [3,3,2] without changing the length at all.
    // The counters stayed at [3,2,2] while the room advertised a 3-cell Submarine, and it sank on
    // the second hit - which is exactly what happened in RESTLESSCUTLASS. Same hole at 6x6, 7x7 and
    // 8x8; the 8x8 Skirmish-to-Classic swap gets two hulls wrong at once.
    //
    // Safe to compare against the pristine array because this effect only runs in the lobby, where
    // nothing has been shot at yet and the counters should always be untouched.
    const cells = room.board_size * room.board_size;
    const pristineHits = initialHitsRemaining(room.ship_defs);
    const hits = myFleet.ship_hits_remaining;
    const misshapen =
      myFleet.ship_grid?.length !== cells ||
      hits?.length !== pristineHits.length ||
      pristineHits.some((n, i) => hits[i] !== n);

    if (!misshapen && !myFleet.placements && !myFleet.placement_confirmed) return; // already clean
    if (resettingRef.current) return;

    resettingRef.current = true;
    (async () => {
      try {
        await resetOwnTeamState(room, team);
      } catch {
        // Nothing actionable for the player here; the lobby still works and they can re-place.
      } finally {
        resettingRef.current = false;
      }
    })();
  }, [state.room, state.myFleet, state.myPlayer?.team]);

  // Attack resolution. Preferred path is the resolve_attack() RPC: it locks the attack row then
  // the fleet row, so it's atomic, needs no compare-and-swap retry, and - crucially - ANY client
  // can drive it, so a team that closed its tab no longer leaves its incoming shots stuck on
  // 'pending' forever. That's why the filter below is every pending attack in the room, not just
  // ones aimed at me.
  //
  // rpcUnavailableRef falls back to the old defender-only client path if the migration adding
  // the function hasn't been applied yet. Without that, a project on the previous schema would
  // simply stop resolving anything at all.
  const inFlightRef = useRef(new Set<string>());
  const rpcUnavailableRef = useRef(false);
  useEffect(() => {
    const room = state.room;
    if (!room) return;
    const myTeam = state.myPlayer?.team;

    const pending = state.attacks.filter(
      (a) => a.cell_index >= 0 && a.result === "pending" && !inFlightRef.current.has(a.id)
    );
    if (pending.length === 0) return;
    pending.forEach((a) => inFlightRef.current.add(a.id));

    /**
     * Take the settled row into local state instead of waiting to be told about it.
     *
     * This is the part that makes a shot stuck on "..." heal itself. resolve_attack() is
     * idempotent: called on a row that is already settled it returns the earlier verdict and
     * writes NOTHING, so there is no UPDATE for realtime to deliver. A client that missed the
     * original UPDATE was therefore asking for the answer on every subsequent shot in the room,
     * getting it back, and throwing it away - the row stayed "pending" locally for the rest of the
     * match while the database had said "miss" all along. Chewy watched a shot of KC's sit on "..."
     * for exactly this reason.
     *
     * The row is re-read rather than patched from the RPC's return value because that value is
     * only the verdict text, and a sunk line also needs the ship's name, size and placement.
     * One indexed read by primary key, and only ever for a row we still hold as pending.
     */
    async function adoptResolved(id: string) {
      const { data } = await supabase.from("attacks").select().eq("id", id).maybeSingle();
      if (data) setState((prev) => withAttack(prev, data as Attack));
    }

    (async () => {
      for (const attack of pending) {
        try {
          if (!rpcUnavailableRef.current) {
            const { error } = await supabase.rpc("resolve_attack", { p_attack_id: attack.id });
            if (!error) {
              await adoptResolved(attack.id);
              continue;
            }
            // Only a missing function should demote us to the legacy path; a transient network
            // or permission error must not permanently disable the good one.
            const missing = /could not find the function|does not exist|schema cache/i.test(error.message);
            if (!missing) continue;
            rpcUnavailableRef.current = true;
          }

          // -- legacy fallback: only the defending team can resolve, via CAS --
          if (myTeam === null || myTeam === undefined || attack.defender_team !== myTeam) continue;

          const { data: claimedRows } = await supabase
            .from("attacks")
            .update({ resolved_at: new Date().toISOString() })
            .eq("id", attack.id)
            .is("resolved_at", null)
            .select();
          if (!claimedRows || claimedRows.length === 0) continue;

          let outcome: ReturnType<typeof resolveAttack> | null = null;
          for (let attempt = 0; attempt < 25; attempt++) {
            const { data: freshFleet } = await supabase
              .from("fleets")
              .select()
              .eq("room_id", room.id)
              .eq("team", myTeam)
              .single();
            if (!freshFleet) break;

            outcome = resolveAttack(
              room.ship_defs,
              {
                shipGrid: freshFleet.ship_grid,
                shipIndexGrid: freshFleet.ship_index_grid,
                shipHitsRemaining: freshFleet.ship_hits_remaining,
                shipSunk: freshFleet.ship_sunk,
                placements: freshFleet.placements,
              },
              attack.cell_index
            );

            const { data: updatedFleetRows } = await supabase
              .from("fleets")
              .update({ ship_hits_remaining: outcome.newHitsRemaining, ship_sunk: outcome.newShipSunk })
              .eq("room_id", room.id)
              .eq("team", myTeam)
              // MUST be JSON.stringify'd: supabase-js renders a raw JS array as `5,4,3,3,2`,
              // which Postgres rejects (22P02) so the filter matches nothing. jsonb comparison
              // is structural, so formatting doesn't matter.
              .eq("ship_hits_remaining", JSON.stringify(freshFleet.ship_hits_remaining))
              .select();
            if (updatedFleetRows && updatedFleetRows.length > 0) break;
            outcome = null;
          }
          if (!outcome) {
            // Hand the claim back; a claim we can't act on would strand the shot at "..." forever.
            await supabase.from("attacks").update({ resolved_at: null }).eq("id", attack.id);
            continue;
          }

          await supabase
            .from("attacks")
            .update({
              result: outcome.result,
              sunk_ship_name: outcome.sunkShip?.name ?? null,
              sunk_ship_size: outcome.sunkShip?.size ?? null,
              sunk_start_row: outcome.sunkShip?.startRow ?? null,
              sunk_start_col: outcome.sunkShip?.startCol ?? null,
              sunk_horizontal: outcome.sunkShip?.isHorizontal ?? null,
            })
            .eq("id", attack.id);

          // Same reason as the RPC path: don't make our own write come back to us the long way.
          await adoptResolved(attack.id);

          if (allShipsSunk(outcome.newShipSunk)) {
            await supabase
              .from("team_ready")
              .upsert({ room_id: room.id, team: myTeam, eliminated: true }, { onConflict: "room_id,team" });
          }
        } finally {
          inFlightRef.current.delete(attack.id);
        }
      }
    })();
  }, [state.attacks, state.myPlayer, state.room, state.players]);

  // End the match once every team but one has lost its whole fleet. Run by any client HOLDING A
  // FLEET (or hosting), from public data only, because the team that just died is exactly the one
  // least likely to still be around to declare it. The write is idempotent, so clients racing to
  // call it is harmless.
  //
  // Spectators used to run it too, and the "rooms update by player" policy let them. They can't
  // any more - see the spectators_cannot_disrupt migration - because the front page now publishes
  // every live battle, so "somebody watching this room" stopped meaning "somebody the room knows".
  // Skipping it here rather than letting the write bounce off RLS keeps the two in step: a blocked
  // update returns no error and no rows, so a spectator would burn finishedRef on a write that
  // never happened and then never look again.
  const finishedRef = useRef(false);
  useEffect(() => {
    const room = state.room;
    if (!room || room.status !== "battle") {
      finishedRef.current = false; // reset so a rematch in this same room can finish again
      return;
    }
    if (finishedRef.current) return;
    const me = state.myPlayer;
    if (!me || (me.team === null && !me.is_host)) return;

    const teams = activeTeams(state.players);
    if (teams.length < 2) return; // a solo/empty room has no one to lose to

    const dead = eliminatedTeamsFromAttacks(state.attacks, room.ship_defs.length);
    for (const t of state.teamReady) {
      if (t.eliminated) dead.add(t.team);
    }
    if (dead.size === 0) return;

    const survivors = teams.filter((t) => !dead.has(t));
    if (survivors.length > 1) return;

    finishedRef.current = true;
    void supabase
      .from("rooms")
      .update({ status: "finished", winner_team: survivors[0] ?? null })
      .eq("id", room.id)
      .then(({ error }) => {
        if (error) finishedRef.current = false; // let a later pass retry
      });
  }, [state.room, state.attacks, state.players, state.teamReady, state.myPlayer]);

  // Realtime Presence: announce ourselves and track who else is actually connected.
  const myPlayerId = state.myPlayer?.id;
  const roomId = state.room?.id;
  useEffect(() => {
    if (!roomId || !myPlayerId) return;

    const channel = supabase.channel(`presence-${roomId}`, {
      config: { presence: { key: myPlayerId } },
    });

    const syncOnline = () => {
      const ids = Object.keys(channel.presenceState());
      setState((prev) =>
        // Skip the update when membership is unchanged - presence fires sync events liberally,
        // and a fresh array identity each time would re-render the whole room for nothing.
        prev.onlinePlayerIds.length === ids.length && ids.every((id) => prev.onlinePlayerIds.includes(id))
          ? prev
          : { ...prev, onlinePlayerIds: ids }
      );
    };

    channel
      .on("presence", { event: "sync" }, syncOnline)
      .on("presence", { event: "join" }, syncOnline)
      .on("presence", { event: "leave" }, syncOnline)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void channel.track({ online_at: new Date().toISOString() });
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [roomId, myPlayerId]);

  // If the room has no host at all (the previous one was kicked, left, or their row was pruned),
  // promote the longest-tenured player. Without this the room is permanently unmanageable: no
  // one can start placement, kick, end the match, or play again. Deterministic server-side
  // ordering makes concurrent callers pick the same winner, so racing is harmless.
  useEffect(() => {
    if (!roomId) return;
    if (state.players.length === 0) return;
    if (state.players.some((p) => p.is_host)) return;
    void supabase.rpc("ensure_room_host", { p_room_id: roomId });
  }, [roomId, state.players]);

  // Publish this room's custom team names before anything downstream renders.
  //
  // Deliberately during render rather than in an effect: teamName() reads a module registry (see
  // lib/teamColors.ts for why it isn't threaded through props), and an effect fires only AFTER
  // children have already rendered - so a rename would display the stale name until some unrelated
  // state change forced another pass. This runs above every consumer in the tree and is a pure
  // function of state.room, so it produces the same result on every re-render.
  setTeamNameOverrides(state.room?.team_names);

  // Clear on unmount so leaving a room doesn't leak its names onto the home page's match history
  // or the leaderboard, which have no room of their own to override them.
  useEffect(() => () => setTeamNameOverrides(null), []);

  return state;
}
