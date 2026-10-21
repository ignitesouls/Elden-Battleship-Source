import type { PrereqNode } from "./prereqCost.ts";

/**
 * What a bot captain has to do before it may do something else - the bot's own rules, read on top
 * of src/data/bossPrereqs.json.
 *
 * Bot-only on purpose. bossPrereqs.json also prices boards for the balancer and vets official seeds,
 * and it does that as a DISCOUNT on measured times that already include this work - see
 * prereqCost.ts. These rules are hard gates instead ("cannot fire here yet"), which is a different
 * job, and putting them in the shared file would reprice every real board mid-season. Rules that
 * belong in both can move across between seasons, deliberately.
 *
 * Every name must match src/data/battleshipChallenges.json exactly; scripts/check-bot.ts checks.
 */

/**
 * Bot rules, by square. Same AND/OR shape as bossPrereqs.json (a nested list is OR). Where a square
 * is in both files, this entry REPLACES the shared one rather than adding to it - Golden Godfrey's
 * shared entry is "DTS or Fortissax", and the pack plays it as DTS, full stop.
 */
export const BOT_PREREQS: Record<string, PrereqNode[]> = {
  "Liurnia Onyx Lord": ["Bluretta"],
  "Rennala, Queen of the Full Moon": ["Liurnia Red Wolf"],
  "Golden Godfrey": ["DTS"],
  Morgott: ["Golden Godfrey"],
  // The sewer Mohg - the board calls him by his tooltip's name.
  "Mohg, the Omen": ["DTS"],
  Esgar: ["DTS"],
};

/** DLC entry: any two of these... */
export const DLC_MINOR_GATES = [
  "Starscourge Radahn",
  "Godrick",
  "Rennala, Queen of the Full Moon",
  "Astel, Naturalborn of the Void",
  "Regal Moose",
  "Rykard",
];

/** ...or any one of these. */
export const DLC_MAJOR_GATES = [
  "Morgott",
  "Fortissax",
  "Mohg, Lord of Blood",
  "Fire Giant",
  "Maliketh, the Black Blade",
  "Malenia",
];

/**
 * Bosses worth doing early whatever your lane, for the runes and upgrade materials - even a DLC
 * captain stops for them before going after entry.
 */
export const EARLY_VALUE = new Set([
  "Consecrated Avatar",
  "Dragonbarrow Avatar",
  "Borealis",
  "Misbegotten Crusader",
  "Theodorix",
]);

/** Shared-table entries that name no boss - "long run" and friends. Never a gate. */
const PLACEHOLDERS = new Set(["long run", "long fight", "restore a great rune"]);

const leaves = (n: PrereqNode): string[] => (Array.isArray(n) ? n.flatMap(leaves) : [n]);

export interface RuleSquare {
  name: string;
  tooltip?: string;
  region?: string;
}

/**
 * Everything gating one square, as AND-of-(name or OR-group). The square's bot rule if it has one,
 * otherwise its shared entry; plus any shared location rule for where it stands. Placeholders out.
 */
export function gatesFor(square: RuleSquare, shared: Record<string, unknown>): PrereqNode[] {
  const own = (BOT_PREREQS[square.name] ?? (Array.isArray(shared[square.name]) ? shared[square.name] : [])) as PrereqNode[];
  const out: PrereqNode[] = [...own];
  const place = (square.tooltip ?? "").split(" - ").slice(1).join(" - ");
  const locations = (shared._locations ?? {}) as Record<string, PrereqNode[]>;
  for (const [where, rule] of Object.entries(locations)) {
    if (place.includes(where)) out.push(...rule);
  }
  return out.filter((n) => !leaves(n).every((leaf) => PLACEHOLDERS.has(leaf)));
}

export function hasDlcEntry(kills: Set<string>): boolean {
  return (
    DLC_MAJOR_GATES.some((g) => kills.has(g)) || DLC_MINOR_GATES.filter((g) => kills.has(g)).length >= 2
  );
}

/**
 * The kills still needed before `name` can be done, in the order to do them - prerequisites of
 * prerequisites first. An OR-group takes whichever option is cheapest to reach, counting its own
 * gates. `lookup` finds a square by name (for its tooltip and region); `cost` prices one kill.
 */
export function stepsTo(
  name: string,
  kills: Set<string>,
  lookup: (name: string) => RuleSquare | undefined,
  shared: Record<string, unknown>,
  cost: (name: string) => number,
  seen: Set<string> = new Set()
): string[] {
  if (kills.has(name) || seen.has(name)) return [];
  seen.add(name);
  const square = lookup(name) ?? { name };
  const plan: string[] = [];
  const have = new Set(kills);
  const add = (steps: string[]) => {
    for (const s of steps) {
      if (have.has(s)) continue;
      plan.push(s);
      have.add(s);
    }
  };

  for (const gate of gatesFor(square, shared)) {
    const options = leaves(gate).filter((o) => !PLACEHOLDERS.has(o));
    if (options.length === 0 || options.some((o) => have.has(o))) continue;
    let best: string[] | null = null;
    let bestCost = Infinity;
    for (const option of options) {
      const route = [...stepsTo(option, have, lookup, shared, cost, new Set(seen)), option];
      const total = route.reduce((s, r) => s + cost(r), 0);
      if (total < bestCost) {
        best = route;
        bestCost = total;
      }
    }
    if (best) add(best);
  }

  if (square.region === "dlc" && !hasDlcEntry(have)) add(entryPlan(have, lookup, shared, cost));
  return plan;
}

/**
 * The cheapest way into the DLC from here: one major gate, or enough minor gates to make two - each
 * with whatever it needs first.
 */
export function entryPlan(
  kills: Set<string>,
  lookup: (name: string) => RuleSquare | undefined,
  shared: Record<string, unknown>,
  cost: (name: string) => number
): string[] {
  if (hasDlcEntry(kills)) return [];
  const priced = (gate: string) => {
    const route = [...stepsTo(gate, kills, lookup, shared, cost), gate];
    return { route, total: route.reduce((s, r) => s + cost(r), 0) };
  };

  let best = { route: [] as string[], total: Infinity };
  for (const g of DLC_MAJOR_GATES) {
    const p = priced(g);
    if (p.total < best.total) best = p;
  }

  const minorHeld = DLC_MINOR_GATES.filter((g) => kills.has(g)).length;
  const minors = DLC_MINOR_GATES.filter((g) => !kills.has(g)).map(priced).sort((a, b) => a.total - b.total);
  const need = 2 - minorHeld;
  if (minors.length >= need) {
    const route: string[] = [];
    for (const m of minors.slice(0, need)) for (const s of m.route) if (!route.includes(s)) route.push(s);
    const total = route.reduce((s, r) => s + cost(r), 0);
    if (total < best.total) best = { route, total };
  }
  return best.route;
}
