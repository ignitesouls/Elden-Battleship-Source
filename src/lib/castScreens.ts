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
  /** The seat's account - what a player frame announces itself under (lib/frameBeacon). */
  userId: string;
  team: number;
  name: string | null;
  twitchLogin: string | null;
}

/** What a box needs off an account's profile: its Twitch channel, and the name to wear. */
export interface ScreenProfile {
  twitchLogin: string | null;
  /** The site nickname, else the Twitch display name - what the site shows for them everywhere. */
  name: string | null;
}

/**
 * The competitor roster in the order the boxes are numbered: by team, then by who sat down first.
 *
 * Spectators and the caster are dropped - they hold no seat and drive no board, so they are not a
 * screen. The order is stable across a match so a refreshed source lands back on the same player,
 * and a sub taking a vacated seat inherits its slot, which is the behaviour a caster wants: the box
 * stays where it is on screen and the face inside it changes.
 *
 * The nametag is the player's site nickname (falling back to their Twitch name), the name the
 * leaderboard and their career page carry - not whatever they typed into this one room. An account
 * with no profile (an anonymous player) wears its room name.
 */
export function screensFromRoster(players: Player[], profiles: Map<string, ScreenProfile>): CastScreen[] {
  return players
    .filter((p) => p.team !== null && p.team !== undefined)
    .slice()
    .sort((a, b) => (a.team as number) - (b.team as number) || a.joined_at.localeCompare(b.joined_at))
    .map((p, i) => {
      const profile = profiles.get(p.user_id);
      return {
        slot: i,
        playerId: p.id,
        userId: p.user_id,
        team: p.team as number,
        name: profile?.name || p.nickname || null,
        twitchLogin: profile?.twitchLogin ?? null,
      };
    });
}

/**
 * Twitch logins and site names for a set of accounts, keyed by auth id - one request.
 *
 * A missing row, an anonymous account or an unapplied column all land as missing for that id rather
 * than at a throw - a box with no channel draws a name plate over an empty frame, which is a
 * perfectly good "seat filled, stream not linked" and far better than a source that errored out on
 * somebody's broadcast.
 */
export async function fetchScreenProfiles(userIds: string[]): Promise<Map<string, ScreenProfile>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const { data, error } = await supabase.from("profiles").select("id,twitch_login,nickname,display_name").in("id", unique);
  if (error || !data) return new Map();

  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return new Map(
    data.map((r) => [
      r.id as string,
      { twitchLogin: text(r.twitch_login), name: text(r.nickname) ?? text(r.display_name) },
    ])
  );
}
