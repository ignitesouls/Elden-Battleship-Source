import { teamName } from "./teamColors";
import { bottleNote, type DeepMark, type IgonEncounter } from "./deepWater";
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
  // The furled finger is a summon sign, so handing one over is the whole of what he wants from you
  // on the rocks: a rust red for a man who has been down there a long time, and the gold of the
  // storm off the peak for the moment he gets up. He is the one find drawn for everybody (see
  // deepMarks), so both of these lines appear in every crew's log rather than only the finder's.
  igon: { text: "IGON GIVES YOU HIS FURLED FINGER", color: "#c98a63" },
  igonAvenged: { text: "IGON SHALL BE TORMENTED NO LONGER", color: "#f0c95a" },
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
 *
 * @param igon every crew's dealings with him, so the shot that killed Bayle can say what it did
 * for the man one square over.
 *
 * The only line here that belongs to a SHOT rather than to a square, and it has to be: Igon is never
 * on Bayle's square, and Bayle's square is an ordinary boss that may well have had a hull sitting on
 * it. So this is the one thing the log can say that no marker can.
 *
 * It rides along as the note instead of replacing the result, because the result is load-bearing -
 * telling a crew IGON where they were expecting HIT would cost them the most important word in the
 * line. The note field already exists for the message in a bottle and already renders in quotes,
 * which is exactly the punctuation a shouted line wants.
 */
export function outcomeText(
  shot: FeedShot,
  deepCells?: ReadonlyMap<number, DeepMark>,
  room?: Room | null,
  igon?: readonly IgonEncounter[] | null
): ShotOutcome {
  const sunk = shot.rows.filter((r) => r.result === "sunk");
  const hits = shot.rows.filter((r) => r.result === "hit");
  const resolved = shot.rows.filter((r) => r.result !== "pending");

  /**
   * Matched on the timestamp as well as the square, because Bayle's square is fired at by every
   * fleet that gets there and each of them kills their own dragon - so the line belongs to the one
   * shot that was somebody's vengeance, not to every shot at that cell.
   *
   * Applied over the top of everything below, so on the vanishingly rare board where Bayle's own
   * square is also holding a bottle, the dragon wins the line. Both happened; only one can be quoted.
   */
  const cry = igon?.some(
    (e) => e.avenged && shot.cellIndex === e.avenged.cellIndex && shot.at === e.avenged.at
  )
    ? "Igon shall be tormented no longer!"
    : undefined;
  const withCry = (o: ShotOutcome): ShotOutcome => (cry ? { ...o, note: cry } : o);

  const deep = deepCells?.get(shot.cellIndex);
  // Guarded on the shot having missed everything: the square a tentacle was found on can be the same
  // square a later shot from another fleet hits a hull on, and that line is about the hull.
  if (deep && sunk.length === 0 && hits.length === 0) {
    // Until now the note lived only in a toast, which had gone by the time anybody finished reading
    // it. The log is the one place in a live match it can sit still.
    if (deep === "bottle" && room) return withCry({ ...DEEP_TEXT[deep], note: bottleNote(room, shot.cellIndex) });
    return withCry(DEEP_TEXT[deep]);
  }

  if (sunk.length > 0) {
    const names = [...new Set(sunk.map((s) => s.sunk_ship_name).filter(Boolean))].join(", ");
    return withCry({ text: `SANK ${names}`, color: "var(--sunk)" });
  }
  if (hits.length > 0) {
    return withCry({ text: hits.length > 1 ? `HIT x${hits.length}` : "HIT", color: "var(--hit)" });
  }
  if (resolved.length === 0) return withCry({ text: "...", color: "var(--text-dim)" });
  return withCry({ text: "miss", color: "var(--text-dim)" });
}

/*
 * sunkCountByTeam() used to live here. It counted a team's losses as the number of DISTINCT sunk
 * ship names, which undercounts every fleet carrying a repeated name - half of them - and it had no
 * callers left. Removed rather than fixed: lib/battleshipLogic.sunkHullFlags is the one answer to
 * this question now, and a second implementation sitting unused is how the wrong one gets picked up
 * again by whoever needs it next.
 */
