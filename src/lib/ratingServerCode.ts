/**
 * Everything the battle-ratings Edge Function runs, in one entry for scripts/build-rating-bundle.mjs.
 *
 * The function rates every board (battleRatingBoards) and, from the same pass over the archive, works out
 * each player's team power (tournament/teamPower). Both are bundled from the app's own source so the
 * server can never disagree with the pages that show the same numbers. Same rule as before: nothing
 * reachable from here may touch the Supabase client, React or the build environment - it runs under Deno.
 */
export * from "./battleRatingBoards";
export { playerPower, replayElo, POWER_PARAMS, type PlayerPower, type PowerGame } from "./tournament/teamPower";
