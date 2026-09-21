import { rng, seedFrom } from "../seededRandom";

/**
 * Suggests how to turn the pool of solo signups into teams. It only ever SUGGESTS: the admin's
 * pairing screen shows the result as an editable draft, and nothing is created until they confirm.
 *
 * The rating is whatever number the caller wants to balance on - career win rate, a seeded
 * strength, anything. This file does not know or care where it comes from; a player without one is
 * treated as average, so a field of mostly unrated newcomers still deals out sensibly instead of
 * pushing everyone unrated to one end.
 */

export interface PoolPlayer {
  id: string;
  rating?: number;
}

/** A team that already exists but is short of players. */
export interface OpenTeam {
  id: string;
  /** How many more players it can take. */
  needs: number;
  /** How strong the members it already has are, in the same units as `rating`. Optional. */
  strength?: number;
}

export type PairingMode = "random" | "balanced";

export interface PairingSuggestion {
  /** Players to add to teams that already exist. */
  fills: Array<{ teamId: string; playerIds: string[] }>;
  /** Brand-new teams, each exactly `teamSize` players. */
  newTeams: string[][];
  /** Players nobody could be found a full team for this time - fewer than `teamSize`. */
  leftover: string[];
}

export interface PairingOptions {
  players: PoolPlayer[];
  teamSize: number;
  openTeams?: OpenTeam[];
  mode: PairingMode;
  /** Same seed, same suggestion - so "suggest again" is a button, not a coin the page re-flips. */
  seed?: string;
}

/**
 * Every player lands in exactly one place - a team that needed them, a new team, or the leftover -
 * and every team the function makes is full.
 *
 *   1. Existing short teams are topped up first, since those are teams that cannot play until they
 *      are. Balanced mode gives the weakest teams the best remaining players.
 *   2. What is left is dealt into new teams of exactly `teamSize`. Balanced mode deals in a snake
 *      (best to team 1, next to team 2 ... then back the other way), which keeps each team's total
 *      within one player's rating of the rest; random mode just deals chunks.
 *   3. Anyone who doesn't fit a full team is the leftover. In balanced mode that is the lowest
 *      rated - somebody has to wait, and putting the strongest on the bench would hollow out every
 *      team - and in random mode it is whoever the shuffle ended on.
 */
export function suggestPairings(opts: PairingOptions): PairingSuggestion {
  const { teamSize, mode } = opts;
  if (!Number.isInteger(teamSize) || teamSize < 1) throw new Error("teamSize must be a whole number of at least 1");

  const rated = opts.players.filter((p) => typeof p.rating === "number");
  const average = rated.length ? rated.reduce((s, p) => s + (p.rating as number), 0) / rated.length : 0;
  const ratingOf = (p: PoolPlayer) => (typeof p.rating === "number" ? p.rating : average);

  const random = rng(seedFrom(opts.seed ?? "pairing"));
  const pool = [...opts.players];
  if (mode === "balanced") {
    // Id as the tiebreak so equal ratings still come out in a stable order.
    pool.sort((x, y) => ratingOf(y) - ratingOf(x) || (x.id < y.id ? -1 : 1));
  } else {
    // Fisher-Yates on a stable starting order, so the seed alone decides the result.
    pool.sort((x, y) => (x.id < y.id ? -1 : 1));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }

  // -- 1. top up the short teams -------------------------------------------------------------------
  const fills: PairingSuggestion["fills"] = [];
  const open = [...(opts.openTeams ?? [])].filter((t) => t.needs > 0);
  if (mode === "balanced") open.sort((x, y) => (x.strength ?? 0) - (y.strength ?? 0) || (x.id < y.id ? -1 : 1));
  for (const team of open) {
    const take = Math.min(team.needs, pool.length);
    if (take === 0) break;
    fills.push({ teamId: team.id, playerIds: pool.splice(0, take).map((p) => p.id) });
  }

  // -- 2 and 3. deal the rest into new teams --------------------------------------------------------
  const teamCount = Math.floor(pool.length / teamSize);
  const dealt = pool.slice(0, teamCount * teamSize);
  const leftover = pool.slice(teamCount * teamSize).map((p) => p.id);

  const newTeams: string[][] = Array.from({ length: teamCount }, () => []);
  if (mode === "balanced") {
    dealt.forEach((player, i) => {
      const row = Math.floor(i / teamCount);
      const col = i % teamCount;
      newTeams[row % 2 === 0 ? col : teamCount - 1 - col].push(player.id);
    });
  } else {
    dealt.forEach((player, i) => newTeams[Math.floor(i / teamSize)].push(player.id));
  }

  return { fills, newTeams, leftover };
}

/**
 * How lopsided a set of teams is: the strongest team's total rating minus the weakest's. What the
 * pairing screen shows next to a draft ("teams within 0.4 of each other") so an admin can tell a
 * fair-looking draft from one that only looks fair.
 */
export function ratingSpread(teams: string[][], ratingOf: (id: string) => number): number {
  if (teams.length === 0) return 0;
  const totals = teams.map((team) => team.reduce((sum, id) => sum + ratingOf(id), 0));
  return Math.max(...totals) - Math.min(...totals);
}
