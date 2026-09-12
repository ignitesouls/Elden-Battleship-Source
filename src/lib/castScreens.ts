import { supabase } from "./supabase";
import type { Player } from "../types/battleship";

/**
 * The player-stream boxes in a casting scene: which Twitch channel belongs in each, and whose name
 * sits over it.
 *
 * -- Why this reads the roster rather than being handed it -------------------------------------
 *
 * A casting scene is generated once, with the caster's overlay token, and then follows them from
 * match to match exactly as every other persistent source does - see lib/streamOverlay. The boxes
 * cannot be baked at download time without going stale the first time somebody subs in, so each one
 * resolves its player live: the caster's token names the room, the room's `players` name the seats,
 * and a seat's `slot` - its index once the competitors are put in a stable order - is what an
 * individual /stream/screen source is pinned to by its `?slot=`.
 *
 * -- Why the Twitch login is a plain profiles read ---------------------------------------------
 *
 * `profiles.twitch_login` is world-readable already: the leaderboard draws every row, and the watch
 * link resolves strangers' handles straight off it - see the watch_handles migration. An OBS
 * browser source is an anonymous session, and it needs no more than anon has here. A login is not a
 * credential, and the player is about to be on the same stream this scene is being built for.
 */

/** One resolved box. `twitchLogin` is null when that seat's account never signed in with Twitch. */
export interface CastScreen {
  /** Index into the competitor roster in stable order - what a screen source's `?slot=` points at. */
  slot: number;
  /** `players.id` of the seat, so the caller can match it to a buildPlayerStats row. */
  playerId: string;
  team: number;
  name: string | null;
  twitchLogin: string | null;
}

/**
 * The competitor roster in the order the boxes are numbered: by team, then by who sat down first.
 *
 * Spectators and the caster are dropped - they hold no seat and drive no board, so they are not a
 * screen. The order is stable across a match so a refreshed source lands back on the same player,
 * and a sub taking a vacated seat inherits its slot, which is the behaviour a caster wants: the box
 * stays where it is on screen and the face inside it changes.
 */
export function screensFromRoster(players: Player[], logins: Map<string, string | null>): CastScreen[] {
  return players
    .filter((p) => p.team !== null && p.team !== undefined)
    .slice()
    .sort((a, b) => (a.team as number) - (b.team as number) || a.joined_at.localeCompare(b.joined_at))
    .map((p, i) => ({
      slot: i,
      playerId: p.id,
      team: p.team as number,
      name: p.nickname || null,
      twitchLogin: logins.get(p.user_id) ?? null,
    }));
}

/**
 * Twitch logins for a set of accounts, keyed by auth id.
 *
 * A missing row, an anonymous account or an unapplied column all land at `null` for that id rather
 * than at a throw - a box with no channel draws a name plate over an empty frame, which is a
 * perfectly good "seat filled, stream not linked" and far better than a source that errored out on
 * somebody's broadcast.
 */
export async function fetchScreenLogins(userIds: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const { data, error } = await supabase.from("profiles").select("id,twitch_login").in("id", unique);
  if (error || !data) return new Map();

  return new Map(
    data.map((r) => [
      r.id as string,
      typeof r.twitch_login === "string" && r.twitch_login ? r.twitch_login : null,
    ])
  );
}
