/**
 * Career aggregation over match_participants rows.
 *
 * Kept in TypeScript rather than SQL views on purpose: the volume is small (a friends' group,
 * a few rows per match), and pure functions here can be unit-tested directly, whereas SQL can
 * only be verified by applying it to the live database first.
 */

export interface ParticipantRow {
  match_key: string;
  user_id: string | null;
  nickname: string;
  team: number;
  won: boolean;
  draw: boolean;
  shots: number;
  hits: number;
  misses: number;
  sunk: number;
  team_ships_lost: number;
  awards: string[];
  room_code: string | null;
  finished_at: string;
  /** Which square set the match was played on. Absent on rows archived before sets existed. */
  square_set?: string | null;
}

export interface CareerStats {
  /** Stable grouping key: the auth user id when signed in, else `name:<nickname>`. */
  key: string;
  userId: string | null;
  nickname: string;
  /** True when backed by a real account, so the UI can distinguish it from a typed-in name. */
  verified: boolean;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  shots: number;
  hits: number;
  misses: number;
  sunk: number;
  shipsLost: number;
  accuracy: number;
  winRate: number;
  awards: Record<string, number>;
  lastPlayed: string | null;
}

/**
 * Groups by account when there is one, by nickname otherwise. Anonymous players sharing a
 * nickname will merge - see the migration's note; that ambiguity is what signing in removes.
 */
export function participantKey(row: { user_id: string | null; nickname: string }): string {
  return row.user_id ?? `name:${row.nickname.trim().toLowerCase()}`;
}

export function aggregateCareers(rows: ParticipantRow[]): CareerStats[] {
  const byKey = new Map<string, CareerStats>();

  for (const r of rows) {
    const key = participantKey(r);
    let c = byKey.get(key);
    if (!c) {
      c = {
        key,
        userId: r.user_id,
        nickname: r.nickname,
        verified: Boolean(r.user_id),
        matches: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        shots: 0,
        hits: 0,
        misses: 0,
        sunk: 0,
        shipsLost: 0,
        accuracy: 0,
        winRate: 0,
        awards: {},
        lastPlayed: null,
      };
      byKey.set(key, c);
    }

    c.matches++;
    if (r.draw) c.draws++;
    else if (r.won) c.wins++;
    else c.losses++;

    c.shots += r.shots;
    c.hits += r.hits;
    c.misses += r.misses;
    c.sunk += r.sunk;
    c.shipsLost += r.team_ships_lost;

    for (const a of r.awards ?? []) c.awards[a] = (c.awards[a] ?? 0) + 1;

    // Keep the most recent nickname so a rename shows the current one, not the first ever used.
    if (!c.lastPlayed || r.finished_at > c.lastPlayed) {
      c.lastPlayed = r.finished_at;
      c.nickname = r.nickname;
    }
  }

  for (const c of byKey.values()) {
    // Rate over totals, never an average of per-match rates - averaging would let one lucky
    // two-shot game count as heavily as a forty-shot slog.
    c.accuracy = c.shots > 0 ? c.hits / c.shots : 0;
    c.winRate = c.matches > 0 ? c.wins / c.matches : 0;
  }

  return [...byKey.values()].sort(
    (a, b) => b.wins - a.wins || b.winRate - a.winRate || b.sunk - a.sunk || b.accuracy - a.accuracy
  );
}

export interface HeadToHead {
  key: string;
  nickname: string;
  /** Matches where both played on OPPOSING teams. */
  played: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
}

export interface TeammateRecord {
  key: string;
  nickname: string;
  /** Matches where both played on the SAME team. */
  played: number;
  wins: number;
  losses: number;
  winRate: number;
}

/** Indexes rows by match so opponents/teammates can be resolved per game. */
function byMatch(rows: ParticipantRow[]): Map<string, ParticipantRow[]> {
  const m = new Map<string, ParticipantRow[]>();
  for (const r of rows) {
    const list = m.get(r.match_key);
    if (list) list.push(r);
    else m.set(r.match_key, [r]);
  }
  return m;
}

/** Every opponent this player has faced, with the record against each. */
export function headToHeadRecords(rows: ParticipantRow[], key: string): HeadToHead[] {
  const out = new Map<string, HeadToHead>();

  for (const participants of byMatch(rows).values()) {
    const me = participants.find((p) => participantKey(p) === key);
    if (!me) continue;

    for (const other of participants) {
      if (other.team === me.team) continue; // teammate, not an opponent
      const oKey = participantKey(other);
      if (oKey === key) continue;

      let h = out.get(oKey);
      if (!h) {
        h = { key: oKey, nickname: other.nickname, played: 0, wins: 0, losses: 0, draws: 0, winRate: 0 };
        out.set(oKey, h);
      }
      h.nickname = other.nickname;
      h.played++;
      if (me.draw) h.draws++;
      else if (me.won) h.wins++;
      else h.losses++;
    }
  }

  for (const h of out.values()) h.winRate = h.played > 0 ? h.wins / h.played : 0;
  return [...out.values()].sort((a, b) => b.played - a.played || b.wins - a.wins);
}

export function teammateRecords(rows: ParticipantRow[], key: string): TeammateRecord[] {
  const out = new Map<string, TeammateRecord>();

  for (const participants of byMatch(rows).values()) {
    const me = participants.find((p) => participantKey(p) === key);
    if (!me) continue;

    for (const other of participants) {
      if (other.team !== me.team) continue;
      const oKey = participantKey(other);
      if (oKey === key) continue;

      let t = out.get(oKey);
      if (!t) {
        t = { key: oKey, nickname: other.nickname, played: 0, wins: 0, losses: 0, winRate: 0 };
        out.set(oKey, t);
      }
      t.nickname = other.nickname;
      t.played++;
      if (me.won) t.wins++;
      else if (!me.draw) t.losses++;
    }
  }

  for (const t of out.values()) t.winRate = t.played > 0 ? t.wins / t.played : 0;
  return [...out.values()].sort((a, b) => b.played - a.played || b.wins - a.wins);
}

/** Everyone who has shared a match with this player, on either side, with your record when they were present. */
export function presenceRecords(rows: ParticipantRow[], key: string): HeadToHead[] {
  const out = new Map<string, HeadToHead>();

  for (const participants of byMatch(rows).values()) {
    const me = participants.find((p) => participantKey(p) === key);
    if (!me) continue;

    for (const other of participants) {
      const oKey = participantKey(other);
      if (oKey === key) continue;

      let h = out.get(oKey);
      if (!h) {
        h = { key: oKey, nickname: other.nickname, played: 0, wins: 0, losses: 0, draws: 0, winRate: 0 };
        out.set(oKey, h);
      }
      h.nickname = other.nickname;
      h.played++;
      if (me.draw) h.draws++;
      else if (me.won) h.wins++;
      else h.losses++;
    }
  }

  for (const h of out.values()) h.winRate = h.played > 0 ? h.wins / h.played : 0;
  return [...out.values()].sort((a, b) => b.played - a.played);
}

/**
 * The player whose presence most reliably coincides with you losing - ranked on sheer loss rate.
 *
 * Deliberately spans BOTH sides of the board. Restricting this to opponents missed the teammate
 * you keep going down with, who is every bit as much a nemesis as anyone shooting at you.
 * `minPlayed` still applies, because a 100% loss rate over one game is a coincidence, not a rival.
 */
export function findNemesis(rows: ParticipantRow[], key: string, minPlayed = 2): HeadToHead | null {
  const candidates = presenceRecords(rows, key).filter((h) => h.played >= minPlayed && h.losses > 0);
  if (candidates.length === 0) return null;
  const lossRate = (h: HeadToHead) => h.losses / h.played;
  return candidates.sort((a, b) => lossRate(b) - lossRate(a) || b.losses - a.losses || b.played - a.played)[0];
}

/** The teammate you win most often with, by win rate when you're on the same side. */
export function findBestTeammate(rows: ParticipantRow[], key: string, minPlayed = 2): TeammateRecord | null {
  const candidates = teammateRecords(rows, key).filter((t) => t.played >= minPlayed && t.wins > 0);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.winRate - a.winRate || b.wins - a.wins || b.played - a.played)[0];
}
