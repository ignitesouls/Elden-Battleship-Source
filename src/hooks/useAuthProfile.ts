import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import {
  supabase,
  profileFromUser,
  resetSignInCache,
  completeTwitchLogin,
  type TwitchProfile,
} from "../lib/supabase";
import { upsertProfile, fetchProfile, saveProfileNickname, NICKNAME_MAX } from "../lib/profiles";

export interface AccountProfile extends TwitchProfile {
  /**
   * The name this player picked for themselves, from `profiles.nickname`. Null means they never
   * picked one, in which case displayName (their Twitch name) is what to show.
   */
  nickname: string | null;
}

/** The name to put on screen for the signed-in player: their own choice, else their Twitch name. */
export function accountName(profile: AccountProfile | null): string | null {
  return profile?.nickname ?? profile?.displayName ?? null;
}

/**
 * One shared account state for the whole app, rather than one per component.
 *
 * The hook used to run its own session lookup per caller, which was harmless while the profile was
 * read-only. It isn't any more: renaming yourself in the Home nickname box has to move the name in
 * the top bar too, and independent copies of the state can't do that. Everything below is module
 * scope so a rename publishes once and every subscriber sees it.
 */
let current: AccountProfile | null = null;
let started = false;
const listeners = new Set<(profile: AccountProfile | null) => void>();

function publish(next: AccountProfile | null): void {
  current = next;
  for (const listener of listeners) listener(next);
}

/**
 * Publishes the session's identity, then fills in the chosen nickname.
 *
 * Two steps on purpose: the nickname is a second round trip, and the top bar shouldn't sit empty
 * waiting for it. The first publish reuses the nickname already in hand when the user id hasn't
 * changed (a token refresh, say) so an established name doesn't flicker back to the Twitch one.
 */
async function adopt(user: User | null): Promise<void> {
  const base = profileFromUser(user);
  if (!base) {
    publish(null);
    return;
  }

  publish({ ...base, nickname: current?.userId === base.userId ? current.nickname : null });

  // Anonymous players have nothing durable to store, and no profiles row to read a nickname from.
  if (!base.isTwitch) return;

  // Mirror the Twitch identity into `profiles` so leaderboard entries can show a real name and
  // avatar. Awaited, not fired and forgotten, so the row is certain to exist before it's read back.
  if (base.displayName) {
    await upsertProfile({
      id: base.userId,
      twitchId: base.twitchId,
      displayName: base.displayName,
      avatarUrl: base.avatarUrl,
    });
  }

  const row = await fetchProfile(base.userId);
  // A sign-out or a second sign-in may have landed while that was in flight; don't overwrite it.
  if (current?.userId !== base.userId) return;
  publish({ ...base, nickname: row?.nickname ?? null });
}

/**
 * Starts the one-time session read and auth subscription.
 *
 * The Twitch redirect is handled separately, by completeTwitchLogin(). It has to be: the identity is
 * written to the user record server-side by an edge function, and that fires no auth event on this
 * client - the session token is unchanged, only the metadata behind it moved. Waiting for
 * onAuthStateChange would leave the player looking anonymous until they reloaded.
 */
function start(): void {
  if (started) return;
  started = true;

  void (async () => {
    // Resolves to null unless this load is the tail end of a Twitch redirect, in which case it
    // returns the freshly-updated user and the getSession() below would still be reading the
    // pre-login one.
    const linked = await completeTwitchLogin();
    if (linked) {
      await adopt(linked);
      return;
    }
    const { data } = await supabase.auth.getSession();
    await adopt(data.session?.user ?? null);
  })();

  // Never unsubscribed: this is app-lifetime state, not a component's. Clearing the memoised
  // sign-in promise on every change makes the next ensureSignedIn() read the new session rather
  // than the one it captured at startup.
  supabase.auth.onAuthStateChange((_event, session) => {
    resetSignInCache();
    void adopt(session?.user ?? null);
  });
}

/**
 * Stores the player's chosen nickname, or clears it with null so their Twitch name returns.
 *
 * Only meaningful for a signed-in player - an anonymous session has no profiles row and no identity
 * to attach a name to, so callers keep using the localStorage copy for those (lib/playerSession).
 * Throws if the write fails, so the caller can say so rather than showing a name that isn't saved.
 */
export async function saveNickname(nickname: string | null): Promise<void> {
  const profile = current;
  if (!profile?.isTwitch) return;

  // Typing your own Twitch name back in is a reset, not an override: storing a copy of it would pin
  // the name as it is today and stop following a later rename on Twitch. Blank means the same.
  const trimmed = nickname?.trim().slice(0, NICKNAME_MAX) ?? "";
  const next = trimmed.length > 0 && trimmed !== profile.displayName ? trimmed : null;
  if (next === profile.nickname) return;

  await saveProfileNickname(profile.userId, next);
  // Re-read rather than reusing `profile`: the save is a round trip, and an auth change during it
  // would make this a write of the previous account's state.
  if (current?.userId === profile.userId) publish({ ...current, nickname: next });
}

/** The signed-in player's Twitch details and chosen nickname, or null while anonymous. */
export function useAuthProfile(): AccountProfile | null {
  const [profile, setProfile] = useState<AccountProfile | null>(current);

  useEffect(() => {
    listeners.add(setProfile);
    // Covers the case where the store resolved between this component's first render and its
    // effect running.
    setProfile(current);
    start();
    return () => {
      listeners.delete(setProfile);
    };
  }, []);

  return profile;
}
