/**
 * The bot opponent: a practice fleet that plays itself.
 *
 * A player's idea - a team or a solo captain who wants a match tonight and has nobody to play. The
 * bot sits on a fleet like anyone else (it is a real `players` row, so every roster, scoreboard and
 * recap already knows how to draw it), places its own ships, and fires on the clock a real crew
 * would. Everything it does happens server-side in the `bot` edge function; a browser in the room
 * only tells it when it is due. See supabase/migrations/20261022000000_bot_opponent.sql.
 *
 * A bot room is always practice - the database refuses it otherwise - so nothing it plays ever
 * reaches the leaderboard, a career, the record book or the boss stats.
 *
 * Extension-qualified imports and no browser modules: the edge function imports this file under
 * Deno, and scripts/check-bot.ts imports it under bare Node.
 */

/**
 * The user id the bot's first seat is filed under. Not a real account - nobody can sign in as it, and
 * the players insert policy (user_id = auth.uid()) means no browser can claim a seat with it either.
 * Must match bot_user_id() in the migration.
 */
export const BOT_USER_ID = "b0700000-0000-4000-8000-000000000b07";

/**
 * One seat per captain when the bot plays as a crew (see botCrew.ts): captain i sits as
 * BOT_CAPTAIN_IDS[i], the first of them being BOT_USER_ID. Six, because a real crew tops out there.
 * Every one shares the prefix is_bot_user() matches in SQL and isBot() matches here.
 */
export const BOT_CAPTAIN_IDS = ["b07", "b08", "b09", "b0a", "b0b", "b0c"].map(
  (tail) => `b0700000-0000-4000-8000-000000000${tail}`
);
const BOT_ID_PREFIX = "b0700000-0000-4000-8000-000000000b";

export type BotTier = "chud" | "tarnished" | "sweat" | "shaker";

/** Weakest first, which is the order the lobby offers them in. */
export const BOT_TIERS: BotTier[] = ["chud", "tarnished", "sweat", "shaker"];

/**
 * How a tier hunts for a ship it hasn't found yet.
 *
 *   random   any square it hasn't fired at
 *   fit      any square one of its unsunk ships could still be lying across
 *   density  the square the most ways of laying its unsunk ships cover - the textbook strong play,
 *            and the one that gets sharper as ships go down: once both 2s are sunk, a one-square
 *            gap is worth nothing and a five-square run is worth a lot
 */
export type HuntStyle = "random" | "fit" | "density";

/**
 * How a tier finishes a ship it has hit.
 *
 *   forgetful  works the squares around the hit, but sometimes wanders off and leaves it
 *   guess      works around the hit and follows a line once it has two in a row
 *   density    the same scoring as hunting, counting only layouts through the hits
 *   knows      always fires along the ship's real direction. The bot's one cheat, and only ever on a
 *              ship it has already found
 */
export type FinishStyle = "forgetful" | "guess" | "density" | "knows";

export interface BotTierSpec {
  tier: BotTier;
  /**
   * The name on the roster. Also the fleet's name, with "'s Fleet" on the end - set_room_bot writes
   * both, as initcap(tier), so the two must stay the tier id capitalised.
   */
  name: string;
  /** What the name alone doesn't say: how hard it is. Printed under the name on the lobby button. */
  difficulty: { en: string; fr: string };
  blurb: { en: string; fr: string };
  /**
   * One captain's median seconds per square. squarePace puts every real captain between 2:18 and
   * 2:58, so the tiers sit around that: Chud slower than anybody, Shaker at the very front of it.
   */
  gapSeconds: number;
  /** Chance a square turns into a wall - the boss you die to six times - of 6 to 18 minutes. */
  wallChance: number;
  /**
   * The first kill, as a multiple of a real captain's: how long the run takes to get going before
   * anything is fired at all. See OPENING_MEDIAN_SECONDS in botBrain. 1 for every tier: they all open
   * like the median real crew, because an early first shot is where a bot most obviously feels
   * unfair, and the tiers have the rest of the match to differ in.
   */
  openingFactor: number;
  /**
   * The crew bot's pace, as a share of a real crew of the same size: how many squares it fires by the
   * same minute. scripts/build-bot-routes.ts calibrates the walk times so Tarnished (1) lands on the
   * archive's median for each crew size; the others are that, scaled.
   */
  pace: number;
  /**
   * The crew bot's accuracy target - hits per shot on the default fleet. Real players average 38.7%
   * over a career, and the best career in the archive is 46.1%, which is what Shaker's 45% stands for.
   * build-bot-routes.ts calibrates each tier's aim to land on it.
   */
  accuracy: number;
  /**
   * Once every ship it hasn't sunk has been hit at least once, the chance a captain drops its route
   * and goes to finish them - the endgame a real crew plays. Chud never does.
   */
  endgame: number;
  /**
   * Goes to finish a ship the moment it is found, rather than once every ship has been. Shaker's
   * "impossible once he finds you" - together with knowing which way a hit ship runs.
   */
  finishAtOnce: boolean;
  /**
   * How quickly the map opens up, as a multiple of the match clock. A square is in reach once the
   * clock has passed its time cost (see unlockThreshold) - the bot does not kill Malenia at minute
   * five. Faster tiers get deeper sooner.
   */
  reach: number;
  hunt: HuntStyle;
  finish: FinishStyle;
}

export const BOT_TIER_SPECS: Record<BotTier, BotTierSpec> = {
  chud: {
    tier: "chud",
    name: "Chud",
    difficulty: { en: "Easy bot", fr: "Bot facile" },
    blurb: {
      en: "Slow, plays his route, and lets his hits go.",
      fr: "Lent, suit son itinéraire, et laisse filer ses touches.",
    },
    gapSeconds: 200,
    wallChance: 0.12,
    openingFactor: 1,
    pace: 0.8,
    accuracy: 0.25,
    endgame: 0,
    finishAtOnce: false,
    reach: 0.8,
    hunt: "random",
    finish: "forgetful",
  },
  tarnished: {
    tier: "tarnished",
    name: "Tarnished",
    difficulty: { en: "Normal bot", fr: "Bot normal" },
    blurb: {
      en: "A real crew's pace. Works his route and follows up the hits along the way.",
      fr: "Le rythme d'un vrai équipage. Suit son itinéraire et exploite les touches en chemin.",
    },
    gapSeconds: 165,
    wallChance: 0.08,
    openingFactor: 1,
    pace: 1,
    accuracy: 0.35,
    endgame: 0.5,
    finishAtOnce: false,
    reach: 1,
    hunt: "fit",
    finish: "guess",
  },
  sweat: {
    tier: "sweat",
    name: "Sweat",
    difficulty: { en: "Hard bot", fr: "Bot difficile" },
    blurb: {
      en: "Faster than a real crew, hunts where your remaining ships are most likely to be, and finishes what he finds.",
      fr: "Plus rapide qu'un vrai équipage, chasse là où vos navires restants ont le plus de chances d'être, et achève ce qu'il trouve.",
    },
    gapSeconds: 145,
    wallChance: 0.05,
    openingFactor: 1,
    pace: 1.1,
    accuracy: 0.4,
    endgame: 1,
    finishAtOnce: false,
    reach: 1.2,
    hunt: "density",
    finish: "density",
  },
  shaker: {
    tier: "shaker",
    name: "Shaker",
    difficulty: { en: "Brutal bot", fr: "Bot impitoyable" },
    blurb: {
      en: "A quarter faster than a real crew. Hunts like Sweat - but once he hits a ship, he always knows which way it runs.",
      fr: "Un quart plus rapide qu'un vrai équipage. Chasse comme Sweat - mais une fois un navire touché, il sait toujours dans quel sens il s'étend.",
    },
    gapSeconds: 135,
    wallChance: 0.02,
    openingFactor: 1,
    pace: 1.25,
    accuracy: 0.45,
    endgame: 1,
    finishAtOnce: true,
    reach: 1.4,
    hunt: "density",
    finish: "knows",
  },
};

export function isBotTier(value: unknown): value is BotTier {
  return typeof value === "string" && (BOT_TIERS as string[]).includes(value);
}

/** Whether a player row is one of the bot's seats rather than a person. */
export function isBot(player: { user_id?: string | null }): boolean {
  return !!player.user_id && player.user_id.startsWith(BOT_ID_PREFIX);
}

/** The people in a room - every player row except the bot's. */
export function humans<T extends { user_id?: string | null }>(players: T[]): T[] {
  return players.filter((p) => !isBot(p));
}
