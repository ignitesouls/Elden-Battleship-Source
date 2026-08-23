import { buildMatchReport, formatReportText } from "./matchReport";
import { challengesForRoom, igonAnchor } from "./challenges";
import { supabase } from "./supabase";
import { bottleNote, type DeepHide } from "./deepWater";
import { deepForArchive } from "./deepArchive";
import type { Attack, Fleet, Player, Room } from "../types/battleship";

/**
 * Copies everything worth keeping out of a match into the durable tables.
 *
 * Single implementation on purpose. It used to live inline in the post-match report, which meant
 * it only ran when somebody actually reached the "finished" screen - so a host hitting "End
 * match" mid-battle silently destroyed the whole match's history, because resetRoomToLobby()
 * deletes every attack row and nothing had archived them yet. Both paths now funnel through here.
 *
 * The four tables are no longer written directly. Everything goes through the `archive_match`
 * RPC, which re-derives every number from the room's own attack log rather than trusting what
 * this browser sends. That is not paranoia about our own client - the anon key ships inside the
 * bundle, and while these tables accepted client-authored inserts, anyone could POST invented
 * career stats attributed to any account. Verified, not theorised.
 *
 * What we still send is what the server genuinely cannot work out: the boss names (a seeded
 * shuffle that only exists in TypeScript), the formatted report text, the award titles, and what
 * the match turned up in the water. Forging any of those changes flavour text, never a leaderboard
 * position.
 *
 * Every write inside the function dedupes on a natural key, so calling it twice for the same
 * match - the report screen archiving it, then the host hitting "Play again" - is a no-op.
 */
export async function archiveMatch(
  room: Room,
  players: Player[],
  attacks: Attack[],
  _fleets: Fleet[],
  deepHides: DeepHide[]
): Promise<void> {
  const report = buildMatchReport(room, players, attacks, deepHides, igonAnchor(room));
  if (report.totalShots === 0) return; // nothing happened; not worth a row

  // Award titles keyed by nickname, which is how the server joins them back onto participants.
  const awards: Record<string, string[]> = {};
  for (const a of report.awards) {
    awards[a.nickname] = [...(awards[a.nickname] ?? []), a.title];
  }

  // What the water gave up. Written because it is otherwise unrecoverable: the finds come from
  // `deep_hides`, which is deleted with the room about an hour after it goes quiet - so a recap read
  // back out of the Almanac had honors naming the Dutchman and a board with nothing on it. Only
  // finds are stored, never a hiding place; see lib/deepArchive.
  const deep = deepForArchive(report.deep, (cell) => bottleNote(room, cell));

  // Boss names indexed by cell, so match_events can be read back by name. The challenge grid is
  // seeded from room.id, so the same index means a different boss in every room - without this
  // the Almanac could never reconstruct which boss a shot was aimed at.
  const challenges = challengesForRoom(room.id, room.board_size * room.board_size, room.square_set, room.seed, room.board_perm).map(
    (c) => c?.name ?? ""
  );

  const { error } = await supabase.rpc("archive_match", {
    p_room_id: room.id,
    p_report_text: formatReportText(report, attacks, room.board_size),
    p_summary: { stats: report.stats, awards: report.awards, deep },
    p_awards: awards,
    p_challenges: challenges,
  });

  if (error) {
    // Surfaced rather than swallowed: a silent failure here means a real match quietly never
    // reaches the record books, and nobody notices until the leaderboard looks wrong.
    console.error("[archive] could not save the match record:", error.message);
    throw error;
  }
}
