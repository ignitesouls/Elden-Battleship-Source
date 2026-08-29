import { supabase } from "./supabase";
import { cached } from "./archiveCache";
import { deepFromAwards, type ArchivedDeep } from "./deepArchive";
import { canonicalSquareName } from "./squareSetFormat";
import type { Award, PlayerStats } from "./matchReport";
import type { ShipDefinition, ShipPlacement } from "../types/battleship";
import { DEFAULT_SQUARE_SET, type SquareSetId } from "./challenges";
import { asMatchBalance, type MatchBalance } from "./matchBalance";

/**
 * Reading finished matches back out of the record books.
 *
 * Nothing here writes, and nothing here needs a room: `rooms`, `fleets` and `attacks` are pruned
 * about an hour after a room goes quiet, so a match older than that exists ONLY as the four
 * archive tables. Every one of them is world-readable by design (`select using (true)`), which is
 * what makes a permanent, linkable page for any past match possible at all.
 *
 * No new storage is involved. archive_match has been writing all of this at the end of every match
 * since the Almanac shipped - the rows are already there, unread. The one late addition rides inside
 * a column that already existed: `summary.deep`, which is what the match turned up in the water (see
 * lib/deepArchive). Matches finished before it landed have no such block, and `archivedDeep` reads
 * their honors for what it can instead.
 */

/** One row of `match_reports` - the recap header, scoreboard and honors, as archived. */
export interface ArchivedMatch {
  match_key: string;
  room_code: string;
  winner_team: number | null;
  duration: string | null;
  total_shots: number;
  /**
   * `{ stats, awards, deep }` exactly as the live recap built them. `deep` is absent on every match
   * archived before the finds were written down - see deepFromAwards for what can be salvaged.
   */
  summary: { stats?: PlayerStats[]; awards?: Award[]; deep?: ArchivedDeep } | null;
  report_text: string;
  square_set?: string | null;
  finished_at: string;
  /**
   * How fair the board was, as the balancer recorded it at deal time - see lib/matchBalance.
   *
   * Null on every match archived before the record was kept, and on every board dealt from a square
   * set with no cost data. The admin sweep backfills what it can.
   */
  balance?: MatchBalance | null;
  /**
   * Struck from every stat and record, while staying right here - see lib/voidedMatches.
   *
   * Read on this page and nowhere else in the archive readers, because voiding changes nothing
   * about how the match is DRAWN. It only means the recap says so, so that a captain who opens a
   * match and cannot find its squares anywhere in their record learns why on the page itself.
   */
  voided?: boolean;
}

export interface ArchivedFleet {
  match_key: string;
  team: number;
  board_size: number;
  room_id: string | null;
  placements: ShipPlacement[] | null;
  ship_defs: ShipDefinition[] | null;
  square_set?: string | null;
}

export interface ArchivedEvent {
  match_key: string;
  nickname: string;
  team: number;
  cell_index: number;
  challenge_name: string | null;
  result: string;
  match_seconds: number | null;
  board_size: number;
  room_id?: string | null;
  square_set?: string | null;
  board_seed?: string | null;
  board_perm?: number[] | null;
}

/** Everything needed to draw one archived match's recap. */
export interface ArchivedMatchDetail {
  report: ArchivedMatch | null;
  fleets: ArchivedFleet[];
  events: ArchivedEvent[];
}

/**
 * How many matches the history list reads, newest first.
 *
 * A deliberate ceiling rather than an oversight, which is why this pages through nothing: every row
 * carries the match's whole `summary` blob, and pulling the entire archive to render a list of
 * twelve would be the heaviest read on the site by some margin. Exported so the list can SAY it is
 * showing the newest 200 once it is against the ceiling - a count that silently stops rising is the
 * part that would mislead, not the cap itself.
 */
export const ARCHIVE_LIST_LIMIT = 200;

/**
 * One line of the history list.
 *
 * A deliberately smaller thing than `ArchivedMatch`: it is what the list can actually be drawn from
 * and no more, so that the type cannot promise a `report_text` the row was never asked for.
 */
export interface ArchivedMatchListing {
  match_key: string;
  room_code: string;
  winner_team: number | null;
  duration: string | null;
  total_shots: number;
  square_set?: string | null;
  finished_at: string;
  /** Only the two blocks `matchName` reads. The finds and the prose stay on the server. */
  summary: { stats?: PlayerStats[]; awards?: Award[] } | null;
}

/**
 * A match's headline row, for lists.
 *
 * Deliberately reads `match_reports` rather than aggregating `match_events`: the recap header was
 * computed once, at the end of the match, from the full attack log. Re-deriving it here from the
 * 5000-row event sample the Almanac happens to hold would quietly disagree with the recap page
 * itself on older matches.
 *
 * -- Why the two arrows -----------------------------------------------------------------------------
 *
 * `summary` is the largest column in the archive, and the list needs two blocks out of it: matchName
 * reads `stats` and `awards`, and reads nothing else. Fetching the whole thing to get them meant
 * also fetching every find in the water and the entire prose recap, for two hundred matches, to
 * render a list of twelve names - 229 KB gzip where 78 KB does the same job.
 *
 * PostgREST projects into jsonb with `->`, so the two blocks come back on their own and are folded
 * into a `summary` shape here, which is what matchName and the list already speak. The one thing
 * that must NOT be done is dropping `summary` outright: the names would all silently fall through to
 * matchName's size-based fallback, and a list of "The Ten-Square Skirmish" repeated twelve times
 * looks like a working page rather than a broken one.
 *
 * -- Why it is cached -------------------------------------------------------------------------------
 *
 * Because it is the largest single read left on the public site, and the Almanac asks for it again
 * on every mount - including the back button, which is exactly how somebody reads a history list:
 * out to a recap, back, out to the next one. Each of those returns used to be another 78 KB.
 *
 * It shares lib/archiveCache with the three stats feeds rather than holding a cache of its own, so
 * the five minutes and the clear-on-archive behaviour are the ones documented there - and a match
 * archived by this tab still appears immediately, because archive_match clears the lot.
 *
 * Deliberately NOT filtered by `voided` even so - see the note on the stats feeds in lib/profiles.
 * A voided match keeps its line in the history list.
 */
export function fetchArchivedMatches(limit = ARCHIVE_LIST_LIMIT): Promise<ArchivedMatchListing[]> {
  return cached(`archive-list:${limit}`, async () => {
    const { data, error } = await supabase
      .from("match_reports")
      .select("match_key,room_code,winner_team,duration,total_shots,square_set,finished_at,stats:summary->stats,awards:summary->awards")
      .order("finished_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];

    return (data as unknown as (Omit<ArchivedMatchListing, "summary"> & {
      stats: PlayerStats[] | null;
      awards: Award[] | null;
    })[]).map(({ stats, awards, ...row }) => ({
      ...row,
      summary: { stats: stats ?? [], awards: awards ?? [] },
    }));
  });
}

/**
 * Everything about one archived match, fetched in parallel.
 *
 * Columns are listed rather than taken wholesale, but this is the one archive read that still asks
 * for nearly all of them, and that is not an oversight: a recap page redraws the whole match, so it
 * genuinely wants the finds, the prose, the fairness record and the board source. What it drops is
 * only what nothing here reads - the row `id`s, and the `user_id`/`finished_at` on events that the
 * recap never looks at.
 *
 * `board_perm` stays on the event rows, unlike the Almanac's bulk feed. The duplication is the same,
 * but the scale is not: this is one match's ~120 rows rather than the archive's 17,000, and leaving
 * the replay path reading exactly where it always has is worth more than the few KB.
 */
export async function fetchArchivedMatch(matchKey: string): Promise<ArchivedMatchDetail> {
  const [report, fleets, events] = await Promise.all([
    supabase
      .from("match_reports")
      .select("match_key,room_code,winner_team,duration,total_shots,summary,report_text,square_set,finished_at,balance,voided")
      .eq("match_key", matchKey)
      .maybeSingle(),
    supabase
      .from("match_fleets")
      .select("match_key,team,board_size,room_id,placements,ship_defs,square_set")
      .eq("match_key", matchKey),
    supabase
      .from("match_events")
      .select("match_key,nickname,team,cell_index,challenge_name,result,match_seconds,board_size,room_id,square_set,board_seed,board_perm")
      .eq("match_key", matchKey),
  ]);
  return {
    report: (report.data as ArchivedMatch) ?? null,
    fleets: (fleets.data as ArchivedFleet[]) ?? [],
    // A match old enough to predate a square's rename recorded the old name. The recap redraws the
    // board from today's set, so the two have to be speaking the same language - see
    // canonicalSquareName.
    events: ((events.data as ArchivedEvent[]) ?? []).map((e) => ({
      ...e,
      challenge_name: canonicalSquareName(e.challenge_name),
    })),
  };
}

/**
 * Which square set a match was played on.
 *
 * The stamped column wins; matches archived before that column existed fall back to the default,
 * which is what they could only ever have been.
 */
export function archivedSquareSet(detail: ArchivedMatchDetail): SquareSetId {
  return (
    detail.report?.square_set ??
    detail.fleets.find((f) => f.square_set)?.square_set ??
    detail.events.find((e) => e.square_set)?.square_set ??
    DEFAULT_SQUARE_SET
  );
}

/**
 * The room id, board seed and balanced layout a match's squares were dealt from.
 *
 * Only `match_events` carries either, and only for matches archived since those columns landed -
 * without them the board cannot be reconstructed, and the recap falls back to showing just the
 * squares somebody actually fired at.
 */
export function archivedBoardSource(detail: ArchivedMatchDetail): {
  roomId: string | null;
  seed: string | null;
  perm: number[] | null;
} {
  return {
    roomId: detail.events.find((e) => e.room_id)?.room_id ?? detail.fleets.find((f) => f.room_id)?.room_id ?? null,
    seed: detail.events.find((e) => e.board_seed)?.board_seed ?? null,
    perm: detail.events.find((e) => e.board_perm)?.board_perm ?? null,
  };
}

/** Board size, taken from whichever archived row carries it. */
export function archivedBoardSize(detail: ArchivedMatchDetail): number {
  return detail.fleets[0]?.board_size ?? detail.events[0]?.board_size ?? 10;
}

/**
 * What a match turned up in the water, however much of it survives.
 *
 * The stored block if there is one, and it is the whole truth when there is: `archiveMatch` writes
 * every find. Otherwise the honors are read for what they happen to name (see deepArchive), and
 * `salvaged` tells the page to say the list is partial rather than quietly presenting it as complete.
 */
export function archivedDeep(detail: ArchivedMatchDetail): ArchivedDeep & { salvaged: boolean } {
  const stored = detail.report?.summary?.deep;
  if (stored) return { finds: stored.finds ?? [], cthulhu: stored.cthulhu, salvaged: false };
  return {
    finds: deepFromAwards(
      detail.report?.summary?.awards ?? [],
      detail.report?.summary?.stats ?? [],
      archivedBoardSize(detail)
    ),
    salvaged: true,
  };
}

/**
  * This match's fairness record, or null when it has none.
  *
  * Narrowed rather than trusted: the column is jsonb, so anything could be in it, and the recap
  * would rather draw no panel than a panel of undefineds.
  */
export function archivedBalance(detail: ArchivedMatchDetail): MatchBalance | null {
  return asMatchBalance(detail.report?.balance);
}

/** The teams that took part, in order. */
export function archivedTeams(detail: ArchivedMatchDetail): number[] {
  const teams = new Set<number>();
  for (const f of detail.fleets) teams.add(f.team);
  for (const e of detail.events) teams.add(e.team);
  for (const s of detail.report?.summary?.stats ?? []) teams.add(s.team);
  return [...teams].sort((a, b) => a - b);
}
