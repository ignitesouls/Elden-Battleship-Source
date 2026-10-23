import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { fetchParticipants, fetchPlayerEvents } from "../lib/profiles";
import { participantKey, type ParticipantRow } from "../lib/careerStats";
import { challengesForRoom, rowSquareSet } from "../lib/challenges";
import { groupIntoShots } from "../lib/attackFeed";
import { teamName } from "../lib/teamColors";
import type { MatchEventRow } from "../lib/almanac";
import {
  livePoints,
  matchupPoints,
  playerHistory,
  type PlayerHistory,
  type RosterEntry,
  type SquareRecords,
  type TalkingPoint,
  type Voice,
} from "../lib/talkingPoints";
import { useLanguage } from "../lib/language";
import type { Attack, Player, Room } from "../types/battleship";

/**
 * Every square's world record on one board, from the battle-ratings function's snapshot - one request.
 *
 * No fallback to working them out here, on purpose: that is the whole shot log, the read the snapshot
 * exists to spare. If the function cannot answer, the desk simply has no world-record points tonight.
 */
async function fetchSquareRecords(set: string): Promise<SquareRecords> {
  const { data, error } = await supabase.functions.invoke("battle-ratings", { body: { records: set } });
  if (error || !data || typeof data.records !== "object" || data.records === null) return {};
  return data.records as SquareRecords;
}

interface History {
  parts: ParticipantRow[];
  histories: Map<string, PlayerHistory>;
  records: SquareRecords;
}

/**
 * The caster desk's talking points (see lib/talkingPoints), before the match and as it happens.
 *
 * What it reads, once per board and roster:
 *   - the participation rows, which the desk's record chase has already asked for - the same cached
 *     feed, so no second request;
 *   - each captain's own shots, one request each (fetchPlayerEvents, on the participant_key index),
 *     cached per player, so a player joining late costs that one player;
 *   - the board's world records, one request to the battle-ratings function.
 *
 * Nothing after that: the live points are re-read from the room's own attacks, which the desk is sent
 * anyway to draw the board.
 */
export function useTalkingPoints(
  room: Room | null | undefined,
  players: Player[],
  attacks: Attack[]
): { before: TalkingPoint[]; live: TalkingPoint[]; loading: boolean } {
  const set = room ? rowSquareSet(room) : null;

  const roster: RosterEntry[] = useMemo(
    () =>
      players
        .filter((p): p is Player & { team: number } => p.team !== null && p.team !== undefined)
        .map((p) => ({ playerId: p.id, key: participantKey(p), nickname: p.nickname, team: p.team })),
    [players]
  );
  // Only who is on the board matters to the reads - not a nickname edit or a pause request.
  const rosterKeys = useMemo(() => [...new Set(roster.map((r) => r.key))].sort().join(","), [roster]);

  const [history, setHistory] = useState<History | null>(null);
  useEffect(() => {
    if (!set || !rosterKeys) return;
    let cancelled = false;
    void (async () => {
      const keys = rosterKeys.split(",");
      const [parts, events, records] = await Promise.all([
        fetchParticipants().catch(() => [] as ParticipantRow[]),
        Promise.all(keys.map((k) => fetchPlayerEvents(k).catch(() => [] as MatchEventRow[]))),
        fetchSquareRecords(set).catch(() => ({}) as SquareRecords),
      ]);
      if (cancelled) return;
      const onBoard = (rows: MatchEventRow[]) => rows.filter((e) => rowSquareSet(e) === set);
      setHistory({
        parts: parts.filter((p) => rowSquareSet(p) === set),
        histories: new Map(keys.map((k, i) => [k, playerHistory(onBoard(events[i] as MatchEventRow[]), k)])),
        records,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [set, rosterKeys]);

  const board = useMemo(() => {
    if (!room) return [];
    const cells = room.board_size * room.board_size;
    return challengesForRoom(room.id, cells, room.square_set, room.seed, room.board_perm, room.seed_set_at);
    // The board is dealt once; its seed and perm are what change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id, room?.board_size, room?.square_set, room?.seed, room?.board_perm, room?.seed_set_at]);
  // History is keyed by the English (archived) name; these are what the points read and compare.
  const squares = useMemo(() => board.map((c) => c.name), [board]);

  /**
   * The desk's language, so a French cast gets a French barnacle. A square is said in French when the
   * set has a French name for it - looked up off tonight's board, which every square a point names is
   * on, except a usual opener that was not dealt tonight; that one falls back to English.
   */
  const lang = useLanguage();
  const voice: Voice = useMemo(() => {
    const french = new Map(board.filter((c) => c.nameFr).map((c) => [c.name, c.nameFr as string]));
    return { lang, square: (name) => (lang === "fr" ? (french.get(name) ?? name) : name) };
  }, [lang, board]);

  const before = useMemo(
    () =>
      history
        ? matchupPoints(roster, history.parts, history.histories, history.records, new Set(squares), teamName, voice)
        : [],
    [history, roster, squares, voice]
  );

  const live = useMemo(
    () =>
      history && room
        ? livePoints(roster, groupIntoShots(attacks, players), (cell) => squares[cell] ?? null, history.histories, history.records, room, voice)
        : [],
    [history, room, roster, attacks, players, squares, voice]
  );

  return { before, live, loading: !!set && !!rosterKeys && history === null };
}
