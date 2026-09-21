import { supabase } from "../supabase";
import type { TournamentFormat } from "./format";
import { CHAMPION_BANNER_DAYS, type EventSummary } from "./frontPage";
import type { Schedule } from "./schedule";
import { matchFromRow, toMatchRows } from "./start";
import type { TMatch } from "./types";

/**
 * Every read and write the tournament screens make, in one place.
 *
 * The rules themselves live in the database - row-level security decides who may see or change what,
 * and the functions (register_team, sign_up_solo, set_tournament_match_score ...) enforce the
 * business rules. Nothing here is a security boundary, and nothing here re-implements a rule: a
 * button the server would refuse still gets sent, and the server's own message is what the player
 * reads. That keeps a rule in one place, which is the only way a rule stays right.
 */

/** A database error surfaced as the message a person should read. */
export class TournamentError extends Error {}

function fail(error: { message: string } | null | undefined): never {
  throw new TournamentError(error?.message ?? "Something went wrong");
}

// ===========================================================================
//  Shapes
// ===========================================================================

export type EventStatus = "draft" | "signup" | "live" | "finished" | "cancelled";

export interface EventDetail {
  id: string;
  name: string;
  description: string;
  status: EventStatus;
  team_size: number;
  max_roster: number;
  max_entrants: number | null;
  signup_closes_at: string | null;
  starts_at: string | null;
  finished_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  champion_name: string | null;
}

export interface RosterMember {
  user_id: string;
  display_name: string;
  is_captain: boolean;
}

export interface TeamRow {
  id: string;
  name: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  seed: number | null;
  forfeited_at: string | null;
  captain_user_id: string;
  roster: RosterMember[];
}

export interface InviteRow {
  id: string;
  twitch_login: string;
  status: "pending" | "accepted" | "declined";
}

export interface FreeAgentRow {
  id: string;
  user_id: string;
  display_name: string;
  note: string | null;
  status: "waiting" | "placed" | "withdrawn";
  placed_entrant_id: string | null;
}

export interface InboxInvite {
  invite_id: string;
  tournament_id: string;
  tournament_name: string;
  team_name: string;
  captain_name: string | null;
  team_size: number;
  roster_count: number;
  max_roster: number;
}

export interface MatchRow {
  id: string;
  key: string;
  stage: "swiss" | "group" | "knockout";
  bracket: string | null;
  grp: number | null;
  round: number;
  phase: number | null;
  idx: number;
  entrant_a: string | null;
  entrant_b: string | null;
  best_of: number;
  score_a: number;
  score_b: number;
  status: "pending" | "ready" | "in_progress" | "done" | "skipped";
  winner: string | null;
  result_kind: "played" | "admin" | "forfeit";
  opens_at: string | null;
  due_at: string | null;
  agreed_at: string | null;
}

// ===========================================================================
//  The front page
// ===========================================================================

/**
 * The events the front page has anything to say about, as summaries.
 *
 * Only what can produce a banner is asked for - open and running events, and finished ones still
 * inside their two weeks - so the reply is a handful of rows however many events have ever run. The
 * cutoff is computed by the caller, from the server's clock, rather than here from the browser's: a
 * laptop a day fast would otherwise drop a champion banner a day early.
 */
export async function fetchFrontPageEvents(serverNowMs: number): Promise<EventSummary[]> {
  const cutoff = new Date(serverNowMs - CHAMPION_BANNER_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("tournaments")
    .select(
      "id, name, status, signup_closes_at, starts_at, finished_at, champion:tournament_entrants!tournaments_champion_id_fkey(name)",
    )
    .or(`status.in.(signup,live),and(status.eq.finished,finished_at.gte.${cutoff})`)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) fail(error);

  return (data ?? []).map((row) => {
    const champion = row.champion as { name: string } | { name: string }[] | null;
    return {
      id: row.id as string,
      name: row.name as string,
      status: row.status as EventSummary["status"],
      signupClosesAt: (row.signup_closes_at as string | null) ?? null,
      startsAt: (row.starts_at as string | null) ?? null,
      finishedAt: (row.finished_at as string | null) ?? null,
      championName: (Array.isArray(champion) ? champion[0]?.name : champion?.name) ?? null,
    };
  });
}

/** The signed-in player's pending invitations, for the front page's "you've been invited" notice. */
export async function fetchMyInbox(): Promise<InboxInvite[]> {
  const { data, error } = await supabase.rpc("my_roster_invites");
  if (error) fail(error);
  return (data ?? []) as InboxInvite[];
}

// ===========================================================================
//  One event
// ===========================================================================

const EVENT_COLUMNS =
  "id, name, description, status, team_size, max_roster, max_entrants, signup_closes_at, starts_at, finished_at, cancelled_at, cancel_reason, champion:tournament_entrants!tournaments_champion_id_fkey(name)";

function toDetail(row: Record<string, unknown>): EventDetail {
  const champion = row.champion as { name: string } | { name: string }[] | null;
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? "",
    status: row.status as EventStatus,
    team_size: row.team_size as number,
    max_roster: row.max_roster as number,
    max_entrants: (row.max_entrants as number | null) ?? null,
    signup_closes_at: (row.signup_closes_at as string | null) ?? null,
    starts_at: (row.starts_at as string | null) ?? null,
    finished_at: (row.finished_at as string | null) ?? null,
    cancelled_at: (row.cancelled_at as string | null) ?? null,
    cancel_reason: (row.cancel_reason as string | null) ?? null,
    champion_name: (Array.isArray(champion) ? champion[0]?.name : champion?.name) ?? null,
  };
}

/** One event, or null if it does not exist - which, for a draft and a non-admin, is what it looks like. */
export async function fetchEvent(id: string): Promise<EventDetail | null> {
  const { data, error } = await supabase.from("tournaments").select(EVENT_COLUMNS).eq("id", id).maybeSingle();
  if (error) fail(error);
  return data ? toDetail(data as Record<string, unknown>) : null;
}

/**
 * The teams the caller may see in an event. Approved teams are public; a pending one is visible only
 * to its own captain and roster (and to admins), so this is one query with different answers for
 * different people - which is what row-level security is for.
 */
export async function fetchTeams(eventId: string): Promise<TeamRow[]> {
  const { data, error } = await supabase
    .from("tournament_entrants")
    .select("id, name, status, seed, forfeited_at, captain_user_id, roster:tournament_roster(user_id, display_name, is_captain)")
    .eq("tournament_id", eventId)
    .order("created_at", { ascending: true });
  if (error) fail(error);
  return (data ?? []) as unknown as TeamRow[];
}

export async function fetchMatches(eventId: string): Promise<MatchRow[]> {
  const { data, error } = await supabase
    .from("tournament_matches")
    .select(
      "id, key, stage, bracket, grp, round, phase, idx, entrant_a, entrant_b, best_of, score_a, score_b, status, winner, result_kind, opens_at, due_at, agreed_at",
    )
    .eq("tournament_id", eventId)
    .order("phase", { ascending: true })
    .order("idx", { ascending: true });
  if (error) fail(error);
  return (data ?? []) as MatchRow[];
}

/** A team's invitations - readable by its captain (and admins) only. */
export async function fetchTeamInvites(entrantId: string): Promise<InviteRow[]> {
  const { data, error } = await supabase
    .from("tournament_invites")
    .select("id, twitch_login, status")
    .eq("entrant_id", entrantId)
    .order("created_at", { ascending: true });
  if (error) fail(error);
  return (data ?? []) as InviteRow[];
}

/** The team's entry code, for its captain. Null until an administrator approves the team. */
export async function fetchEntryCode(entrantId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("tournament_entrant_secrets")
    .select("entry_code")
    .eq("entrant_id", entrantId)
    .maybeSingle();
  if (error) fail(error);
  return (data?.entry_code as string | null) ?? null;
}

/** The caller's own place in the solo pool for this event, if they have one. */
export async function fetchMyFreeAgent(eventId: string, userId: string): Promise<FreeAgentRow | null> {
  const { data, error } = await supabase
    .from("tournament_free_agents")
    .select("id, user_id, display_name, note, status, placed_entrant_id")
    .eq("tournament_id", eventId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) fail(error);
  return (data as FreeAgentRow | null) ?? null;
}

// ===========================================================================
//  Signing up
// ===========================================================================

/** Splits a box of Twitch names - one per line, or separated by commas or spaces - into a clean list. */
export function parseLogins(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))];
}

export async function registerTeam(eventId: string, name: string, logins: string[]): Promise<string> {
  const { data, error } = await supabase.rpc("register_team", { p_tournament: eventId, p_name: name, p_logins: logins });
  if (error) fail(error);
  return data as string;
}

export async function inviteToTeam(entrantId: string, logins: string[]): Promise<number> {
  const { data, error } = await supabase.rpc("invite_to_roster", { p_entrant: entrantId, p_logins: logins });
  if (error) fail(error);
  return (data as number) ?? 0;
}

export async function respondToInvite(inviteId: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc("respond_to_roster_invite", { p_invite: inviteId, p_accept: accept });
  if (error) fail(error);
}

export async function cancelInvite(inviteId: string): Promise<void> {
  const { error } = await supabase.from("tournament_invites").delete().eq("id", inviteId);
  if (error) fail(error);
}

export async function signUpSolo(eventId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc("sign_up_solo", { p_tournament: eventId, p_note: note.trim() || null });
  if (error) fail(error);
}

export async function withdrawSolo(eventId: string): Promise<void> {
  const { error } = await supabase.rpc("withdraw_solo", { p_tournament: eventId });
  if (error) fail(error);
}

export async function renameTeam(entrantId: string, name: string): Promise<void> {
  const { error } = await supabase.from("tournament_entrants").update({ name }).eq("id", entrantId);
  if (error) fail(error);
}

export async function withdrawTeam(entrantId: string): Promise<void> {
  const { error } = await supabase.from("tournament_entrants").update({ status: "withdrawn" }).eq("id", entrantId);
  if (error) fail(error);
}

/** Leave a team you are on (or, as its captain, remove a teammate) while signup is open. */
export async function leaveTeam(entrantId: string, userId: string): Promise<void> {
  const { error } = await supabase.from("tournament_roster").delete().eq("entrant_id", entrantId).eq("user_id", userId);
  if (error) fail(error);
}

// ===========================================================================
//  Administrators
// ===========================================================================

export interface AdminEventRow extends EventDetail {
  created_at: string;
  team_count: number;
  pending_count: number;
  waiting_count: number;
}

/** Every event, drafts included - only an administrator's session can read the drafts. */
export async function adminListEvents(): Promise<AdminEventRow[]> {
  const { data, error } = await supabase
    .from("tournaments")
    .select(`${EVENT_COLUMNS}, created_at`)
    .order("created_at", { ascending: false });
  if (error) fail(error);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const ids = rows.map((r) => r.id as string);
  const counts = new Map<string, { approved: number; pending: number; waiting: number }>();
  for (const id of ids) counts.set(id, { approved: 0, pending: 0, waiting: 0 });

  if (ids.length > 0) {
    const [teams, agents] = await Promise.all([
      supabase.from("tournament_entrants").select("tournament_id, status").in("tournament_id", ids),
      supabase.from("tournament_free_agents").select("tournament_id").eq("status", "waiting").in("tournament_id", ids),
    ]);
    if (teams.error) fail(teams.error);
    if (agents.error) fail(agents.error);
    for (const t of teams.data ?? []) {
      const c = counts.get(t.tournament_id as string);
      if (!c) continue;
      if (t.status === "approved") c.approved++;
      else if (t.status === "pending") c.pending++;
    }
    for (const a of agents.data ?? []) {
      const c = counts.get(a.tournament_id as string);
      if (c) c.waiting++;
    }
  }

  return rows.map((row) => {
    const c = counts.get(row.id as string)!;
    return { ...toDetail(row), created_at: row.created_at as string, team_count: c.approved, pending_count: c.pending, waiting_count: c.waiting };
  });
}

export interface NewEvent {
  name: string;
  description: string;
  team_size: number;
  max_roster: number;
  max_entrants: number | null;
  signup_closes_at: string | null;
}

/** Creates an event as a draft - invisible to everyone but administrators until signup is opened. */
export async function createEvent(fields: NewEvent): Promise<string> {
  const { data, error } = await supabase
    .from("tournaments")
    .insert({ ...fields, status: "draft" })
    .select("id")
    .single();
  if (error) fail(error);
  return data.id as string;
}

export async function updateEvent(id: string, patch: Partial<NewEvent>): Promise<void> {
  const { error } = await supabase.from("tournaments").update(patch).eq("id", id);
  if (error) fail(error);
}

export async function setEventStatus(id: string, status: EventStatus): Promise<void> {
  const { error } = await supabase.from("tournaments").update({ status }).eq("id", id);
  if (error) fail(error);
}

export async function cancelEvent(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_tournament", { p_tournament: id, p_reason: reason.trim() || null });
  if (error) fail(error);
}

export async function deleteEvent(id: string): Promise<void> {
  const { error } = await supabase.from("tournaments").delete().eq("id", id);
  if (error) fail(error);
}

export interface AdminTeamRow extends TeamRow {
  entry_code: string | null;
}

/** Every team in an event including pending ones, with entry codes - administrators only. */
export async function adminTeams(eventId: string): Promise<AdminTeamRow[]> {
  const { data, error } = await supabase
    .from("tournament_entrants")
    .select(
      "id, name, status, seed, forfeited_at, captain_user_id, roster:tournament_roster(user_id, display_name, is_captain), secrets:tournament_entrant_secrets(entry_code)",
    )
    .eq("tournament_id", eventId)
    .order("created_at", { ascending: true });
  if (error) fail(error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const secrets = row.secrets as { entry_code: string | null } | { entry_code: string | null }[] | null;
    const code = Array.isArray(secrets) ? secrets[0]?.entry_code : secrets?.entry_code;
    return { ...(row as unknown as TeamRow), entry_code: code ?? null };
  });
}

export async function setTeamStatus(entrantId: string, status: "approved" | "rejected" | "pending"): Promise<void> {
  const { error } = await supabase.from("tournament_entrants").update({ status }).eq("id", entrantId);
  if (error) fail(error);
}

export async function regenerateEntryCode(entrantId: string): Promise<string> {
  const { data, error } = await supabase.rpc("regenerate_entry_code", { p_entrant: entrantId });
  if (error) fail(error);
  return data as string;
}

/**
 * Starts an event: seeds the teams, saves the format and schedule, draws the first stage and goes live,
 * all in one step that either happens entirely or not at all.
 *
 * `seeded` is the entered teams' ids, best seed first. The database checks that this is exactly the set
 * of approved teams, and - like everything else here - that the caller is an administrator; this call
 * is not what keeps anyone else out, the function it calls is.
 */
export async function startEvent(
  eventId: string,
  format: TournamentFormat,
  schedule: Schedule,
  seeded: string[],
  matches: TMatch[],
): Promise<number> {
  const { data, error } = await supabase.rpc("start_tournament", {
    p_tournament: eventId,
    p_format: format,
    p_schedule: schedule,
    p_seeds: seeded,
    p_matches: toMatchRows(matches),
  });
  if (error) fail(error);
  return data as number;
}

// ===========================================================================
//  Official matches
// ===========================================================================

/** The events that are running right now. Official matches only exist while at least one is. */
export async function fetchLiveEvents(): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await supabase.from("tournaments").select("id, name").eq("status", "live").order("created_at");
  if (error) fail(error);
  return (data ?? []) as Array<{ id: string; name: string }>;
}

export interface OfficialAnswer {
  ok: boolean;
  error?: string;
  match_key?: string;
  team_a?: string;
  team_b?: string;
  you_are?: "a" | "b";
  already?: boolean;
}

/**
 * The official-match functions answer with a small JSON value and never raise for a wrong code: a raised
 * error would roll back the record of the wrong guess that the throttle depends on. So a refusal is a
 * normal answer with `ok: false` and the words to show, and only a genuine failure (the network) throws.
 */
async function officialCall(fn: string, args: Record<string, unknown>): Promise<OfficialAnswer> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) fail(error);
  return (data ?? { ok: false, error: "No answer" }) as OfficialAnswer;
}

/** Host: make this room the official match of the team whose entry code this is. */
export const linkOfficialRoom = (roomId: string, eventId: string, code: string) =>
  officialCall("link_official_room", { p_room: roomId, p_tournament: eventId, p_code: code });

/** Anyone in the room: confirm the OTHER team with its entry code. */
export const confirmOfficialTeam = (roomId: string, code: string) =>
  officialCall("confirm_official_team", { p_room: roomId, p_code: code });

/** Host (before the match starts) or an administrator: make it an ordinary room again. */
export const unlinkOfficialRoom = (roomId: string) => officialCall("unlink_official_room", { p_room: roomId });

export interface OfficialMatchInfo {
  eventName: string;
  teamA: string;
  teamB: string;
  bestOf: number;
  scoreA: number;
  scoreB: number;
  round: string;
}

/** What a lobby says about the match it is playing: who, in what event, and where the series stands. */
export async function fetchOfficialMatch(matchId: string): Promise<OfficialMatchInfo | null> {
  const { data: m, error } = await supabase
    .from("tournament_matches")
    .select("tournament_id, entrant_a, entrant_b, best_of, score_a, score_b, stage, phase, round")
    .eq("id", matchId)
    .maybeSingle();
  if (error) fail(error);
  if (!m) return null;
  const ids = [m.entrant_a, m.entrant_b].filter(Boolean) as string[];
  const [teams, event] = await Promise.all([
    supabase.from("tournament_entrants").select("id, name").in("id", ids),
    supabase.from("tournaments").select("name").eq("id", m.tournament_id).maybeSingle(),
  ]);
  const name = (id: string | null) => (teams.data ?? []).find((t) => t.id === id)?.name ?? "?";
  return {
    eventName: (event.data?.name as string | undefined) ?? "",
    teamA: name(m.entrant_a),
    teamB: name(m.entrant_b),
    bestOf: m.best_of,
    scoreA: m.score_a,
    scoreB: m.score_b,
    round: `${m.stage} ${m.phase ?? m.round}`,
  };
}

export interface OfficialFailure {
  id: string;
  created_at: string;
  match_key: string | null;
  room_code: string | null;
  error: string;
}

/** Official results the bracket could not take (administrators). The game itself was still archived. */
export async function fetchOfficialFailures(): Promise<OfficialFailure[]> {
  const { data, error } = await supabase
    .from("official_result_failures")
    .select("id, created_at, match_key, room_code, error")
    .eq("resolved", false)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) fail(error);
  return (data ?? []) as OfficialFailure[];
}

export async function resolveOfficialFailure(id: string): Promise<void> {
  const { error } = await supabase.from("official_result_failures").update({ resolved: true }).eq("id", id);
  if (error) fail(error);
}

/** Whether the Official record exists yet - true once the first event has gone live. */
export async function officialStatsEnabled(): Promise<boolean> {
  const { data, error } = await supabase.rpc("official_stats_enabled");
  if (error) return false;
  return data === true;
}

export interface OfficialRecordRow {
  player_key: string;
  display_name: string;
  played: number;
  wins: number;
}

export async function fetchOfficialLeaderboard(): Promise<OfficialRecordRow[]> {
  const { data, error } = await supabase.rpc("official_leaderboard");
  if (error) fail(error);
  return ((data ?? []) as Array<{ player_key: string; display_name: string; played: number | string; wins: number | string }>).map((r) => ({
    player_key: r.player_key,
    display_name: r.display_name,
    played: Number(r.played),
    wins: Number(r.wins),
  }));
}

// ===========================================================================
//  Running an event (administrators)
// ===========================================================================

export interface EventConfig {
  /** Null until the event is started: an unstarted event's saved format is an empty object, not a format. */
  format: TournamentFormat | null;
  schedule: Schedule;
}

/** The saved format and schedule. The format is fixed once the event is live; the schedule keeps moving. */
export async function fetchEventConfig(eventId: string): Promise<EventConfig> {
  const { data, error } = await supabase.from("tournaments").select("format, schedule").eq("id", eventId).single();
  if (error) fail(error);
  const saved = data.format as Partial<TournamentFormat> | null;
  // `{}` is what a not-yet-started event holds. Handing that on as a format would be a lie the type system
  // cannot catch - it is truthy, and every field on it is missing - so it is turned into null here, once,
  // where callers are forced to deal with "there is no format yet".
  const format = saved && typeof saved === "object" && saved.qualifier ? (saved as TournamentFormat) : null;
  return { format, schedule: data.schedule as Schedule };
}

/** The timers an event's official rooms are played by, as saved. Empty for an event that never set any. */
export async function fetchMatchSettings(eventId: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.from("tournaments").select("match_settings").eq("id", eventId).single();
  if (error) fail(error);
  return (data.match_settings as Record<string, unknown>) ?? {};
}

/** Save an event's official-match rules. Editable at any time; rooms linked from then on take them. */
export async function saveMatchSettings(eventId: string, settings: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from("tournaments").update({ match_settings: settings }).eq("id", eventId);
  if (error) fail(error);
}

export async function saveSchedule(eventId: string, schedule: Schedule): Promise<void> {
  const { error } = await supabase.from("tournaments").update({ schedule }).eq("id", eventId);
  if (error) fail(error);
}

export interface StoredMatches {
  /** Every match, as the engine's own type - what the planners for later stages are fed. */
  matches: TMatch[];
  /** The database id behind each match key, for the calls that address a match by id. */
  ids: Map<string, string>;
  /** Agreed times, which the engine has no field for. */
  agreed: Map<string, string | null>;
}

export async function fetchStoredMatches(eventId: string): Promise<StoredMatches> {
  const { data, error } = await supabase.from("tournament_matches").select("*").eq("tournament_id", eventId);
  if (error) fail(error);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return {
    matches: rows.map(matchFromRow),
    ids: new Map(rows.map((r) => [r.key as string, r.id as string])),
    agreed: new Map(rows.map((r) => [r.key as string, (r.agreed_at as string | null) ?? null])),
  };
}

/** Draws the next Swiss round, or the knockout after a qualifier. Refused if it is the wrong moment. */
export async function drawStage(eventId: string, stage: "swiss" | "knockout", matches: TMatch[]): Promise<number> {
  const { data, error } = await supabase.rpc("add_tournament_matches", {
    p_tournament: eventId,
    p_stage: stage,
    p_matches: toMatchRows(matches),
  });
  if (error) fail(error);
  return data as number;
}

/** Enter or correct a result. 0-0 reverts the match. */
export async function enterScore(matchId: string, scoreA: number, scoreB: number): Promise<void> {
  const { error } = await supabase.rpc("set_tournament_match_score", { p_match: matchId, p_score_a: scoreA, p_score_b: scoreB });
  if (error) fail(error);
}

export async function forfeitMatchById(matchId: string, loser: "a" | "b"): Promise<void> {
  const { error } = await supabase.rpc("forfeit_tournament_match", { p_match: matchId, p_loser: loser });
  if (error) fail(error);
}

/** Take a team out of a running event; everything it is due to play is forfeited. */
export async function removeTeam(entrantId: string): Promise<void> {
  const { error } = await supabase.rpc("forfeit_team", { p_entrant: entrantId });
  if (error) fail(error);
}

/** Bring a removed team back. Forfeits already recorded stay as results. */
export async function reinstateTeam(entrantId: string): Promise<void> {
  const { error } = await supabase.from("tournament_entrants").update({ forfeited_at: null }).eq("id", entrantId);
  if (error) fail(error);
}

export async function substitutePlayer(entrantId: string, outUserId: string, inLogin: string): Promise<void> {
  const { error } = await supabase.rpc("substitute_player", { p_entrant: entrantId, p_out: outUserId, p_in_login: inLogin });
  if (error) fail(error);
}

export async function handOverCaptain(entrantId: string, newCaptainId: string): Promise<void> {
  const { error } = await supabase.rpc("hand_over_tournament_captaincy", { p_entrant: entrantId, p_new_captain: newCaptainId });
  if (error) fail(error);
}

export async function setRoundWindow(eventId: string, stage: string, phase: number, opens: string, due: string): Promise<number> {
  const { data, error } = await supabase.rpc("set_round_window", { p_tournament: eventId, p_stage: stage, p_phase: phase, p_opens: opens, p_due: due });
  if (error) fail(error);
  return data as number;
}

/** Record when two teams have agreed to play (or clear it with null). Captains may do this for their own match too. */
export async function setMatchTime(matchId: string, at: string | null): Promise<void> {
  const { error } = await supabase.rpc("set_match_time", { p_match: matchId, p_at: at });
  if (error) fail(error);
}

export interface OverdueRow {
  match_id: string;
  match_key: string;
  stage: string;
  phase: number;
  due_at: string;
  status: string;
  entrant_a: string | null;
  entrant_b: string | null;
  agreed_at: string | null;
}

/** Open matches past their deadline, oldest first, by the database's clock. */
export async function fetchOverdue(eventId: string): Promise<OverdueRow[]> {
  const { data, error } = await supabase.rpc("overdue_tournament_matches", { p_tournament: eventId });
  if (error) fail(error);
  return (data ?? []) as OverdueRow[];
}

/** Pair waiting solo players into a new, approved team. */
export async function formTeamFromPool(eventId: string, name: string, userIds: string[], captainId?: string): Promise<string> {
  const { data, error } = await supabase.rpc("form_team_from_free_agents", {
    p_tournament: eventId,
    p_name: name,
    p_user_ids: userIds,
    p_captain: captainId ?? null,
  });
  if (error) fail(error);
  return data as string;
}

/** Put a waiting solo player on a team that has room. */
export async function placeFromPool(entrantId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc("assign_free_agent_to_team", { p_entrant: entrantId, p_user: userId });
  if (error) fail(error);
}

export async function adminFreeAgents(eventId: string): Promise<FreeAgentRow[]> {
  const { data, error } = await supabase
    .from("tournament_free_agents")
    .select("id, user_id, display_name, note, status, placed_entrant_id")
    .eq("tournament_id", eventId)
    .order("created_at", { ascending: true });
  if (error) fail(error);
  return (data ?? []) as FreeAgentRow[];
}
