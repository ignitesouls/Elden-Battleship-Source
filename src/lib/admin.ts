import { useEffect, useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabase";
import { clearVoidedCache } from "./voidedMatches";
import { clearArchiveCache } from "./archiveCache";

export interface AdminRow {
  user_id: string;
  display_name: string | null;
  is_owner: boolean;
  granted_at: string;
}

export interface AdminStatus {
  isAdmin: boolean;
  isOwner: boolean;
  loading: boolean;
}

/**
 * Whether the signed-in account may manage the record books.
 *
 * Asks the database rather than inferring anything client-side. Nothing here is a security
 * boundary - RLS is - so a tampered response only ever reveals buttons whose actions the server
 * would still refuse. It exists to avoid showing controls that would fail.
 *
 * `enabled` skips the pair of round trips entirely, for callers that already know the answer is no.
 * The top bar uses it: admin rights hang off a Twitch account, so an anonymous visitor asking is
 * two guaranteed `false`s on every page of the site. Answers `false, done` rather than staying in
 * `loading` forever, so a caller can render its "not for you" state without special-casing this.
 */
export function useAdminStatus(enabled = true): AdminStatus {
  const [status, setStatus] = useState<AdminStatus>({ isAdmin: false, isOwner: false, loading: true });

  useEffect(() => {
    if (!isSupabaseConfigured || !enabled) {
      setStatus({ isAdmin: false, isOwner: false, loading: false });
      return;
    }
    let cancelled = false;

    async function check() {
      const [{ data: admin }, { data: owner }] = await Promise.all([
        supabase.rpc("is_admin"),
        supabase.rpc("is_owner"),
      ]);
      if (!cancelled) setStatus({ isAdmin: !!admin, isOwner: !!owner, loading: false });
    }

    void check();
    // Re-checked on sign-in/out: the answer is a property of the session, and without this the
    // panel would stay hidden until a reload after logging in.
    const { data: sub } = supabase.auth.onAuthStateChange(() => void check());
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [enabled]);

  return status;
}

export async function listAdmins(): Promise<AdminRow[]> {
  const { data, error } = await supabase
    .from("admins")
    .select("user_id, display_name, is_owner, granted_at")
    .order("is_owner", { ascending: false })
    .order("granted_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as AdminRow[];
}

/**
 * Grants admin by Twitch display name.
 *
 * Resolved through `profiles`, which means the person must have signed in with Twitch at least
 * once. That's a feature rather than a limitation: it proves the account exists and pins the grant
 * to a real user id instead of a name someone could later claim.
 */
export async function grantAdmin(displayName: string): Promise<{ ok: boolean; message: string }> {
  const name = displayName.trim();
  if (!name) return { ok: false, message: "Enter a Twitch display name." };

  const { data: matches, error: lookupErr } = await supabase
    .from("profiles")
    .select("id, display_name")
    .ilike("display_name", name)
    .limit(2);
  if (lookupErr) return { ok: false, message: lookupErr.message };

  if (!matches || matches.length === 0) {
    return { ok: false, message: `No Twitch account called "${name}" has signed in yet. Ask them to log in once first.` };
  }
  if (matches.length > 1) {
    return { ok: false, message: `More than one account matches "${name}".` };
  }

  const { error } = await supabase.from("admins").insert({
    user_id: matches[0].id,
    display_name: matches[0].display_name,
    is_owner: false,
    granted_by: (await supabase.auth.getUser()).data.user?.id ?? null,
  });
  if (error) {
    // 23505 is the primary-key clash, i.e. they already had it. Not worth an error.
    if (error.code === "23505") return { ok: false, message: `${matches[0].display_name} is already an admin.` };
    return { ok: false, message: error.message };
  }
  return { ok: true, message: `${matches[0].display_name} is now an admin.` };
}

export async function revokeAdmin(userId: string): Promise<void> {
  const { error } = await supabase.from("admins").delete().eq("user_id", userId);
  if (error) throw error;
}

/**
 * Deletes one archived match from all four record tables.
 *
 * They share no foreign keys - everything is joined on the text `match_key` - so each table has to
 * be cleared explicitly. Missing one leaves an orphan that still feeds the Almanac's heatmaps
 * while being invisible on the leaderboard, which is a genuinely confusing state to debug.
 */
export async function deleteMatchRecord(matchKey: string): Promise<void> {
  for (const table of ["match_events", "match_fleets", "match_participants"] as const) {
    const { error } = await supabase.from(table).delete().eq("match_key", matchKey);
    if (error) throw error;
  }
  const { error } = await supabase.from("match_reports").delete().eq("match_key", matchKey);
  if (error) throw error;
}

/**
 * Strikes a whole match from the record books without deleting a thing.
 *
 * The third and gentlest of the three tools here, and the only one that is reversible. "Delete"
 * destroys four tables' worth of rows; "Crew" strikes one name from a match everybody else keeps;
 * this leaves every row where it is and makes the site read past all of them. For a match whose
 * shots were real but whose clock is not - a held backlog dumped in one burst - it is the only one
 * of the three that does not throw away true results to fix false ones.
 *
 * Verified by re-reading, for the reason removeParticipantFromMatch spells out: RLS makes a blocked
 * write affect zero rows and report no error, so an admin who had quietly lost the role would
 * otherwise see a success and a list that never changed.
 */
export async function setMatchVoided(matchKey: string, voided: boolean): Promise<void> {
  // The report's own flag first, while there still is a report: the recap page and the admin list
  // read it. Zero rows updated is the normal case for a swept match, not a failure. First, because it
  // is the write that refuses to un-void a practice match - doing it second would lift the durable
  // void and only then be told no.
  const { error: reportErr } = await supabase.from("match_reports").update({ voided }).eq("match_key", matchKey);
  if (reportErr) throw reportErr;

  // voided_matches is what every stat reads, and the only place a void survives the 30-day sweep
  // of match_reports - it is also the only place a match older than that CAN be voided, since its
  // report is already gone. See 20261003000000_durable_voids.sql.
  const write = voided
    ? supabase.from("voided_matches").upsert({ match_key: matchKey }, { onConflict: "match_key", ignoreDuplicates: true })
    : supabase.from("voided_matches").delete().eq("match_key", matchKey);
  const { error } = await write;
  if (error) throw error;

  const { data } = await supabase
    .from("voided_matches")
    .select("match_key")
    .eq("match_key", matchKey)
    .maybeSingle();
  if (Boolean(data) !== voided) {
    const state = voided ? "counting" : "voided";
    throw new Error("That match is still " + state + " - check you're still an admin.");
  }

  // The stats fetchers hold the voided list for the life of the page, so the next read would
  // otherwise still be working from the list as it was before this click. The feeds themselves are
  // cached too, and they were filtered THROUGH that list - so dropping one without the other would
  // leave a voided match counting until the feed cache happened to expire.
  clearVoidedCache();
  clearArchiveCache();
}

export interface MatchParticipant {
  id: string;
  match_key: string;
  user_id: string | null;
  nickname: string;
  team: number;
  won: boolean;
  draw: boolean;
  shots: number;
  hits: number;
  sunk: number;
}

/** Everyone recorded in one archived match, so a single name can be struck from it. */
export async function listMatchParticipants(matchKey: string): Promise<MatchParticipant[]> {
  const { data, error } = await supabase
    .from("match_participants")
    .select("id, match_key, user_id, nickname, team, won, draw, shots, hits, sunk")
    .eq("match_key", matchKey)
    .order("team", { ascending: true });
  if (error) throw error;
  return (data ?? []) as MatchParticipant[];
}

/**
 * Strikes one player from one archived match, leaving the match itself intact.
 *
 * The blunt instrument next to this is "Delete" on the whole match, which punishes everyone who
 * played it for one bad row - a test run somebody joined by accident, a name that shouldn't be on
 * the board, a career polluted by a game that wasn't really theirs.
 *
 * Three tables carry a per-player trace and all three have to go, or the leaderboard and the
 * Almanac end up disagreeing about who was there:
 *
 *   match_participants - the career row (wins, shots, accuracy). This is the leaderboard.
 *   match_events       - their individual shots. This is the Almanac's heatmaps and timings.
 *   match_reports.summary - the recap's scoreboard and honors, rewritten rather than deleted so
 *                           the match page still renders for everybody else.
 *
 * Deletes are verified by re-reading. Postgres RLS makes a DELETE with no matching policy affect
 * zero rows and report NO error, so a silently-blocked wipe would otherwise look like a success.
 */
export async function removeParticipantFromMatch(matchKey: string, nickname: string): Promise<void> {
  const { error: partErr } = await supabase
    .from("match_participants")
    .delete()
    .eq("match_key", matchKey)
    .eq("nickname", nickname);
  if (partErr) throw partErr;

  const { error: evErr } = await supabase
    .from("match_events")
    .delete()
    .eq("match_key", matchKey)
    .eq("nickname", nickname);
  if (evErr) throw evErr;

  const { data: left } = await supabase
    .from("match_participants")
    .select("id")
    .eq("match_key", matchKey)
    .eq("nickname", nickname);
  if ((left ?? []).length > 0) {
    throw new Error(`${nickname} is still on that match - check you're still an admin.`);
  }

  // The recap is opaque JSON, so it can only be edited whole: read it, drop this name from both
  // lists, write it back. A failure here is deliberately not fatal - the numbers that feed every
  // ranking are already gone by this point, and the recap is prose.
  const { data: report } = await supabase
    .from("match_reports")
    .select("summary")
    .eq("match_key", matchKey)
    .maybeSingle();

  const summary = report?.summary as { stats?: unknown[]; awards?: unknown[] } | null | undefined;
  if (summary && (Array.isArray(summary.stats) || Array.isArray(summary.awards))) {
    const named = (row: unknown) =>
      typeof row === "object" && row !== null && (row as { nickname?: string }).nickname === nickname;
    await supabase
      .from("match_reports")
      .update({
        summary: {
          ...summary,
          stats: (summary.stats ?? []).filter((s) => !named(s)),
          awards: (summary.awards ?? []).filter((a) => !named(a)),
        },
      })
      .eq("match_key", matchKey);
  }
}

export interface MatchShot {
  id: string;
  match_key: string;
  nickname: string;
  team: number;
  cell_index: number;
  challenge_name: string | null;
  result: string;
  match_seconds: number | null;
}

/**
 * Every archived shot in one match, in the order they were fired.
 *
 * One row per trigger-pull, not per defending fleet - the archive already collapsed those (see
 * archive_match). So a row here is exactly one square somebody marked, which is the granularity a
 * mismark happens at.
 *
 * Nulls in `match_seconds` sort last: they're shots from a match whose start marker never landed,
 * so they have no place in the sequence but still exist and still count.
 */
export async function listMatchShots(matchKey: string): Promise<MatchShot[]> {
  const { data, error } = await supabase
    .from("match_events")
    .select("id, match_key, nickname, team, cell_index, challenge_name, result, match_seconds")
    .eq("match_key", matchKey);
  if (error) throw error;

  return ((data ?? []) as MatchShot[]).sort(
    (a, b) =>
      (a.match_seconds ?? Infinity) - (b.match_seconds ?? Infinity) || a.cell_index - b.cell_index
  );
}

/**
 * Deletes one archived shot and rebalances the totals that counted it.
 *
 * The reason to reach for this over "Remove" on the crew list: a square marked by mistake is one
 * bad row, and striking the player from the match to be rid of it throws away every honest shot
 * they fired that night. It's also the only tool that fixes the derived records - the timing and
 * streak records are built from these rows directly (recordBook.archivedShots), so a square marked
 * at the wrong moment can hold "quickest first blood" forever and there is nothing else to point at.
 *
 * The record that was WORST served by this - "quickest two bosses", won by whoever marked two
 * squares closest together - has since been dropped rather than policed, on the grounds that a
 * record needing an admin to keep it honest was never really a record. See the note at the top of
 * lib/recordBook.
 *
 * The counters are stored, not derived, so they have to be walked back by hand. The deltas mirror
 * exactly how archive_match counted them in the first place:
 *
 *   shots   every shot
 *   hits    hit and sunk both connected
 *   misses  only an outright miss - a 'pending' shot was counted in neither
 *   sunk    a sinking
 *
 * Two things it deliberately does not touch, because the event row cannot answer them:
 *
 *   - A shot that sank ships belonging to TWO fleets at once counted twice in `sunk`, and the row
 *     only remembers that it sank something. Rare, and only reachable in a 3+ team match.
 *   - `team_ships_lost` on the defending side. The archive never recorded whose ship went down,
 *     so guessing is worse than leaving it - the UI says so before you press the button.
 *
 * Verified by re-reading: RLS makes a DELETE with no matching policy affect zero rows and report
 * no error, so a blocked delete would otherwise look like a success and then quietly skew the
 * counters below it.
 */
export async function deleteMatchShot(shot: MatchShot): Promise<void> {
  const { error } = await supabase.from("match_events").delete().eq("id", shot.id);
  if (error) throw error;

  const { data: left } = await supabase.from("match_events").select("id").eq("id", shot.id);
  if ((left ?? []).length > 0) {
    throw new Error("The shot wasn't deleted - check you're still an admin.");
  }

  const { data: row } = await supabase
    .from("match_participants")
    .select("id, shots, hits, misses, sunk")
    .eq("match_key", shot.match_key)
    .eq("nickname", shot.nickname)
    .eq("team", shot.team)
    .maybeSingle();

  if (row) {
    const down = (n: number, by = 1) => Math.max(0, n - by);
    await supabase
      .from("match_participants")
      .update({
        shots: down(row.shots),
        hits: shot.result === "hit" || shot.result === "sunk" ? down(row.hits) : row.hits,
        misses: shot.result === "miss" ? down(row.misses) : row.misses,
        sunk: shot.result === "sunk" ? down(row.sunk) : row.sunk,
      })
      .eq("id", row.id);
  }

  // The headline shot count on the match list and the recap page. Left alone if the report is
  // already gone - an orphaned event is still worth deleting.
  const { data: report } = await supabase
    .from("match_reports")
    .select("id, total_shots")
    .eq("match_key", shot.match_key)
    .maybeSingle();
  if (report) {
    await supabase
      .from("match_reports")
      .update({ total_shots: Math.max(0, report.total_shots - 1) })
      .eq("id", report.id);
  }
}

/**
 * Moves one archived shot to a different point in the match.
 *
 * The other half of deleteMatchShot, and the half that fits the commoner mistake: the square really
 * was killed, the mark just landed late (or early). Deleting it to fix a clock throws away a real
 * kill - it vanishes from the Almanac and from that player's totals - when all that was ever wrong
 * was one number.
 *
 * Nothing has to be rebalanced afterwards, unlike a deletion. Every consumer of `match_seconds`
 * derives its answer at read time from these rows - the timing and streak records
 * (recordBook.archivedShots), the Almanac's per-boss times, the replay's ordering - so the single
 * UPDATE fixes all of them. The stored counters on match_participants and match_reports count
 * shots, not when they happened, so they are untouched by design.
 *
 * `seconds` is measured the way the archive measures it: from the drop of the countdown, so the
 * first shot of a match is a small positive number. Negative is refused rather than clamped; the
 * caller is reading a clock off a VOD and a negative reading means they misread it.
 *
 * Verified by re-reading the row: with no matching UPDATE policy, RLS makes the write affect zero
 * rows and report no error, so a blocked edit would otherwise look like it took.
 */
export async function updateMatchShotTime(shot: MatchShot, seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("That isn't a time in the match - give it as M:SS or a number of seconds.");
  }
  const value = Math.round(seconds);

  const { error } = await supabase
    .from("match_events")
    .update({ match_seconds: value })
    .eq("id", shot.id);
  if (error) throw error;

  const { data: after } = await supabase
    .from("match_events")
    .select("match_seconds")
    .eq("id", shot.id)
    .maybeSingle();
  if (!after || after.match_seconds !== value) {
    throw new Error("The shot's time wasn't changed - check you're still an admin.");
  }
}

export interface LiveRoom {
  id: string;
  code: string;
  status: string;
  created_at: string;
  players: number;
}

/**
 * Live rooms with their occupancy, for the admin's room list.
 *
 * The limit is a backstop rather than paging: the site allows fifteen rooms open at once, so it
 * only bites if that cap is ever broken, and a list that quietly stopped at twenty-five would still
 * be showing every room there is.
 *
 * The occupancy count asks only about the rooms being listed. It used to read the room_id of every
 * player row on the site to count fifteen rooms' worth - a whole table fetched to answer a question
 * about a page of it.
 */
export async function listRooms(limit = 25): Promise<LiveRoom[]> {
  const { data: rooms, error } = await supabase
    .from("rooms")
    .select("id, code, status, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const ids = (rooms ?? []).map((r) => r.id);
  // Skipped when there are no rooms: an `.in()` on an empty list is a round trip that can only
  // come back empty.
  const { data: players } = ids.length
    ? await supabase.from("players").select("room_id").in("room_id", ids)
    : { data: [] as { room_id: string }[] };
  const counts = new Map<string, number>();
  for (const p of players ?? []) counts.set(p.room_id, (counts.get(p.room_id) ?? 0) + 1);

  return (rooms ?? []).map((r) => ({ ...r, players: counts.get(r.id) ?? 0 }) as LiveRoom);
}

/** Deletes a room. Cascades to its players, fleets, attacks and team_ready rows. */
export async function deleteRoom(id: string): Promise<void> {
  const { error } = await supabase.from("rooms").delete().eq("id", id);
  if (error) throw error;
  const { data: left } = await supabase.from("rooms").select("id").eq("id", id);
  if ((left ?? []).length > 0) throw new Error("The room wasn't deleted - check you're still an admin.");
}

/** Runs the stale-room sweep on demand rather than waiting for the next room creation. */
export async function pruneRooms(): Promise<number> {
  const { data, error } = await supabase.rpc("admin_prune_rooms");
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function renamePlayerAsAdmin(playerId: string, nickname: string): Promise<void> {
  const { error } = await supabase.from("players").update({ nickname }).eq("id", playerId);
  if (error) throw error;
}

export async function kickPlayerAsAdmin(playerId: string): Promise<void> {
  const { error } = await supabase.from("players").delete().eq("id", playerId);
  if (error) throw error;
}

/**
 * Everything in the record books as one JSON file.
 *
 * Worth having because deletion here is genuinely permanent - these tables have no soft-delete
 * and Supabase's free tier has no point-in-time restore, so "Erase all records" is unrecoverable
 * without this. Taking a copy first turns an irreversible button into a reversible one.
 */
export async function exportRecords(): Promise<void> {
  const [reports, participants, fleets, events] = await Promise.all([
    supabase.from("match_reports").select(),
    supabase.from("match_participants").select(),
    supabase.from("match_fleets").select(),
    supabase.from("match_events").select(),
  ]);

  const payload = {
    exported_at: new Date().toISOString(),
    match_reports: reports.data ?? [],
    match_participants: participants.data ?? [],
    match_fleets: fleets.data ?? [],
    match_events: events.data ?? [],
  };

  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `elden-battleship-records-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const RECORD_TABLES = ["match_events", "match_fleets", "match_participants", "match_reports"] as const;

/**
 * Rows in the satellite tables with no surviving `match_reports` row.
 *
 * These are reachable only here, which is the whole problem: the panel lists matches from
 * match_reports, so an orphan is invisible in the UI while still counting toward the leaderboard,
 * which aggregates match_participants directly. One turned up in the wild - a row carrying a real
 * user_id but no parent report showed up as a 999-shot career with nothing to click delete on.
 *
 * Asked of Postgres rather than answered in the browser. This used to fetch the match_key of every
 * row in all three tables and diff them here - match_events is a row per shot ever fired, so it was
 * tens of thousands of rows downloaded on every visit to /admin to arrive at one integer. The panel
 * runs it unprompted, precisely because an orphan announces itself nowhere else, so it is the one
 * read on the page that could not be made cheaper by loading less of it.
 *
 * See admin_count_orphans in 20260831000000_count_orphans.sql. It raises rather than returning zero
 * for a non-admin, and the callers here treat any failure as zero - which is the same thing the
 * panel would show anyway.
 */
export async function countOrphans(): Promise<number> {
  const { data, error } = await supabase.rpc("admin_count_orphans");
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function deleteOrphans(): Promise<number> {
  const { data: reports } = await supabase.from("match_reports").select("match_key");
  const keys = new Set((reports ?? []).map((r) => r.match_key as string));

  let removed = 0;
  for (const table of ["match_participants", "match_fleets", "match_events"] as const) {
    const { data } = await supabase.from(table).select("match_key");
    const orphanKeys = [...new Set((data ?? []).map((r) => r.match_key as string).filter((k) => !keys.has(k)))];
    for (const key of orphanKeys) {
      const { error } = await supabase.from(table).delete().eq("match_key", key);
      if (error) throw error;
      removed++;
    }
  }
  return removed;
}

/**
 * Wipes every archived match.
 *
 * Clears each table outright rather than looping over keys read from match_reports. The key-driven
 * version had a hole: anything whose parent report was already gone was never visited, so "erase
 * everything" could leave orphaned participant rows still feeding the leaderboard.
 *
 * `.not("match_key","is",null)` is just a match-everything filter - supabase-js refuses an
 * unfiltered delete, which is a sensible guard against exactly the accident this function is.
 */
export async function deleteAllMatchRecords(): Promise<number> {
  const { data: before } = await supabase.from("match_reports").select("match_key");
  const matches = (before ?? []).length;

  for (const table of RECORD_TABLES) {
    const { error } = await supabase.from(table).delete().not("match_key", "is", null);
    if (error) throw error;
  }

  // A DELETE with no matching policy affects zero rows and reports NO error at all, so the only
  // trustworthy confirmation is re-reading every table.
  let left = 0;
  for (const table of RECORD_TABLES) {
    const { data } = await supabase.from(table).select("match_key");
    left += (data ?? []).length;
  }
  if (left > 0) throw new Error(`${left} row(s) could not be deleted - check you're still an admin.`);
  return matches;
}
