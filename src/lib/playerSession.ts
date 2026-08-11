const KEY_PREFIX = "eb_player_";

/** Remembers which `players` row this browser owns for a given room, so refreshing doesn't create a duplicate. */
export function getStoredPlayerId(roomCode: string): string | null {
  return localStorage.getItem(KEY_PREFIX + roomCode.toUpperCase());
}

export function storePlayerId(roomCode: string, playerId: string): void {
  localStorage.setItem(KEY_PREFIX + roomCode.toUpperCase(), playerId);
}

/**
 * Forgets the seat this browser held in a room.
 *
 * Called when you leave of your own accord. Without it the id lingers, and the room page reads a
 * stored id with no matching row as "the host or an admin removed you" - which is a startling
 * thing to be told about a door you walked out of yourself.
 */
export function clearStoredPlayerId(roomCode: string): void {
  localStorage.removeItem(KEY_PREFIX + roomCode.toUpperCase());
}

const ACTIVE_ROOM_KEY = "eb_active_room";

/**
 * The room this browser is currently sitting in, if any.
 *
 * Only exists so the top bar can offer a way back: opening the leaderboard mid-match used to be a
 * one-way trip unless you knew to press Back, and a player who followed a link from the recap had
 * no route to the room they were still in.
 *
 * Cleared on leaving, being removed, or finding the room gone - a stale "back to SALTY KRAKEN"
 * pointing at a deleted room would be worse than no link.
 */
export function getActiveRoom(): string | null {
  return localStorage.getItem(ACTIVE_ROOM_KEY);
}

export function setActiveRoom(roomCode: string): void {
  localStorage.setItem(ACTIVE_ROOM_KEY, roomCode.toUpperCase());
}

export function clearActiveRoom(roomCode?: string): void {
  // Scoped clear: leaving room A shouldn't wipe the trail back to room B if another tab has since
  // joined one. Without a code it's an unconditional clear.
  if (roomCode && getActiveRoom() !== roomCode.toUpperCase()) return;
  localStorage.removeItem(ACTIVE_ROOM_KEY);
}

const NICKNAME_KEY = "eb_last_nickname";

export function getLastNickname(): string {
  return localStorage.getItem(NICKNAME_KEY) ?? "";
}

export function storeLastNickname(nickname: string): void {
  localStorage.setItem(NICKNAME_KEY, nickname);
}
