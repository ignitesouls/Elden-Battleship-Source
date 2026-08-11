import { teamName } from "./teamColors";
import { bottleNote, type DeepMark } from "./deepWater";
import type { Attack, Player, Room } from "../types/battleship";

export interface FeedShot {
  key: string;
  at: string;
  attackerTeam: number;
  who: string;
  cellIndex: number;
  rows: Attack[];
}

/**
 * One player action produces one `attacks` row per opposing team, all inserted in a single
 * statement - so they share an identical created_at. Grouping on that collapses them back
 * into the single shot the player actually took.
 */
export function groupIntoShots(attacks: Attack[], players: Player[]): FeedShot[] {
  const byShot = new Map<string, FeedShot>();

  // Negative indices are bookkeeping rows (the match-start marker), not shots anyone fired.
  for (const a of attacks.filter((x) => x.cell_index >= 0)) {
    const key = `${a.attacker_player_id ?? a.attacker_team}|${a.cell_index}|${a.created_at}`;
    let shot = byShot.get(key);
    if (!shot) {
      const player = players.find((p) => p.id === a.attacker_player_id);
      shot = {
        key,
        at: a.created_at,
        attackerTeam: a.attacker_team,
        who: player?.nickname ?? teamName(a.attacker_team),
        cellIndex: a.cell_index,
        rows: [],
      };
      byShot.set(key, shot);
    }
    shot.rows.push(a);
  }

  return [...byShot.values()].sort((x, y) => y.at.localeCompare(x.at));
}

/**
 * What the log calls each of the things hiding in the water.
 *
 * Each colour is the one its marker is drawn in, so the line and the square agree without a legend:
 * spectral green for the ghost ship, bottle-cream for the note, ceramic for Alexander, and Patches in
 * his own complexion. See HitMarkers.tsx for where each of these came from.
 */
const DEEP_TEXT: Record<DeepMark, { text: string; color: string }> = {
  whale: { text: "THE WHITE WHALE", color: "var(--accent)" },
  laboon: { text: "LABOON - he shrugs it off", color: "var(--splash)" },
  // A quiet grey for an arm in the dark, and the colour of the eye itself for the moment it opens.
  tentacle: { text: "SOMETHING DOWN THERE", color: "#a8b8b4" },
  sleeper: { text: "IT WAKES", color: "#f4e08a" },
  dutchman: { text: "A SAIL, AND NOTHING UNDER IT", color: "#bff0dd" },
  bottle: { text: "A BOTTLE, WITH SOMETHING IN IT", color: "#f3e6c8" },
  jar: { text: "SOMETHING CERAMIC, AND STUCK", color: "#cdb9cd" },
  jarFree: { text: "ALEXANDER, LOOSE AT LAST", color: "#e2d3e0" },
  // The quotes are the joke and they are load-bearing. He is not sorry.
  patches: { text: 'PATCHES - he is "sorry"', color: "#e3c7a4" },
};

/** One shot, as the log prints it. */
export interface ShotOutcome {
  text: string;
  color: string;
  /**
   * What the bottle said, for the crew that fished it out. Its own line, because the notes run to
   * fifty characters and the outcome column is one line of nowrap.
   */
  note?: string;
}

/**
 * @param deepCells What has been found in the water, keyed by square (see lib/deepWater.ts). Every
 * one of those shots is a miss against every fleet, so without this the rarest lines in the log read
 * as the dullest ones.
 *
 * It is also the whole of the who-may-see-what rule for this line. `deepMarks` gives a crew only its
 * OWN finds, so a bottle fished out by the red fleet is a bottle in the red fleet's log and a plain
 * miss in everyone else's - and since a bottle is CAUGHT rather than met, the second crew to fire at
 * that square genuinely found nothing and "miss" is the honest word for it.
 *
 * @param room only for the note in the bottle, which is seeded off the room and the square and stored
 * nowhere (see deepWater.bottleNote). Omit it and the line still reads, just without the message.
 */
export function outcomeText(
  shot: FeedShot,
  deepCells?: ReadonlyMap<number, DeepMark>,
  room?: Room | null
): ShotOutcome {
  const sunk = shot.rows.filter((r) => r.result === "sunk");
  const hits = shot.rows.filter((r) => r.result === "hit");
  const resolved = shot.rows.filter((r) => r.result !== "pending");

  const deep = deepCells?.get(shot.cellIndex);
  // Guarded on the shot having missed everything: the square a tentacle was found on can be the same
  // square a later shot from another fleet hits a hull on, and that line is about the hull.
  if (deep && sunk.length === 0 && hits.length === 0) {
    // Until now the note lived only in a toast, which had gone by the time anybody finished reading
    // it. The log is the one place in a live match it can sit still.
    if (deep === "bottle" && room) return { ...DEEP_TEXT[deep], note: bottleNote(room, shot.cellIndex) };
    return DEEP_TEXT[deep];
  }

  if (sunk.length > 0) {
    const names = [...new Set(sunk.map((s) => s.sunk_ship_name).filter(Boolean))].join(", ");
    return { text: `SANK ${names}`, color: "var(--sunk)" };
  }
  if (hits.length > 0) {
    return { text: hits.length > 1 ? `HIT x${hits.length}` : "HIT", color: "var(--hit)" };
  }
  if (resolved.length === 0) return { text: "...", color: "var(--text-dim)" };
  return { text: "miss", color: "var(--text-dim)" };
}

/** Ships each team has lost, derived from the public attack log (no fleet access needed). */
export function sunkCountByTeam(attacks: Attack[]): Map<number, number> {
  const names = new Map<number, Set<string>>();
  for (const a of attacks) {
    if (a.result !== "sunk" || !a.sunk_ship_name) continue;
    let s = names.get(a.defender_team);
    if (!s) {
      s = new Set();
      names.set(a.defender_team, s);
    }
    s.add(a.sunk_ship_name);
  }
  const counts = new Map<number, number>();
  for (const [team, set] of names) counts.set(team, set.size);
  return counts;
}
