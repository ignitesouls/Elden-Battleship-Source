/**
 * What a group in a group stage is called.
 *
 * An administrator can name the groups (tournaments.group_names, by group number); a group they have not
 * named is "Group A", "Group B" ... as it always was. The lists below are the names they can pick from
 * instead of typing - sea terms, and places and figures from the game, so a group draw reads like part of
 * it. Any name can still be typed or edited freely. A name is stored exactly as written, so it reads the
 * same in either language.
 *
 * Pure: no database, no React - the event page, the desk and the checks all use the same rule.
 */

export interface GroupNameSet {
  id: string;
  label: [en: string, fr: string];
  names: string[];
}

export const GROUP_NAME_SETS: GroupNameSet[] = [
  {
    id: "nautical",
    label: ["Nautical", "Nautique"],
    names: [
      "Kraken", "Leviathan", "Maelstrom", "Riptide", "Undertow", "Broadside", "Crow's Nest", "Starboard",
      "Port Side", "Deep Water", "High Tide", "Anchor", "Keel", "Fathom", "Squall", "Davy Jones",
    ],
  },
  {
    id: "waters",
    label: ["Waters of the Lands Between", "Eaux de l'Entre-terre"],
    names: [
      "Liurnia of the Lakes", "Lake of Rot", "Siofra River", "Ainsel River", "Cerulean Coast", "Coastal Cave",
      "Stillwater Cave", "Lakeside Crystal Cave", "Weeping Peninsula", "Nokron", "Deeproot Depths",
    ],
  },
  {
    id: "regions",
    label: ["The Lands Between", "L'Entre-terre"],
    names: [
      "Limgrave", "Weeping Peninsula", "Liurnia", "Caelid", "Dragonbarrow", "Altus Plateau", "Mt. Gelmir", "Leyndell",
      "Mountaintops of the Giants", "Consecrated Snowfield", "Siofra River", "Ainsel River", "Nokron", "Deeproot Depths",
      "Lake of Rot", "Haligtree",
    ],
  },
  {
    id: "legacy",
    label: ["Legacy dungeons", "Donjons légendaires"],
    names: [
      "Stormveil Castle", "Raya Lucaria", "Caria Manor", "Redmane Castle", "Volcano Manor", "Leyndell", "Castle Sol",
      "Miquella's Haligtree", "Crumbling Farum Azula", "Shadow Keep", "Belurat", "Enir-Ilim",
    ],
  },
  {
    id: "demigods",
    label: ["Demigods", "Demi-dieux"],
    names: ["Godrick", "Rennala", "Radahn", "Rykard", "Morgott", "Mohg", "Malenia", "Godwyn", "Miquella", "Messmer", "Ranni", "Marika"],
  },
  {
    id: "shadow",
    label: ["Realm of Shadow", "Royaume des Ombres"],
    names: [
      "Gravesite Plain", "Scadu Altus", "Cerulean Coast", "Jagged Peak", "Abyssal Woods", "Ancient Ruins of Rauh",
      "Charo's Hidden Grave", "Stone Coffin Fissure", "Hinterland", "Scaduview", "Shadow Keep", "Belurat",
    ],
  },
];

/** The letter a group goes by when it has no name: 0 -> A. */
export function groupLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** What group `index` (counting from 0) is called on screen. */
export function groupLabel(names: readonly string[] | null | undefined, index: number, lang: "en" | "fr"): string {
  const named = names?.[index]?.trim();
  if (named) return named;
  return lang === "fr" ? `Poule ${groupLetter(index)}` : `Group ${groupLetter(index)}`;
}

/**
 * `count` names from a set, in a random order - so two events filled from the same list don't both get
 * Limgrave and Liurnia. Fewer if the set is short; the rest stay unnamed (and show their letter).
 */
export function pickGroupNames(set: GroupNameSet, count: number, random: () => number = Math.random): string[] {
  const pool = [...set.names];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export const MAX_GROUP_NAME = 40;

/**
 * Whether a list of names may be saved - the same rule the database's group_names_ok() enforces, checked
 * here first so the panel can say what is wrong before the save rather than after. Returns the problem,
 * or null. Names are expected trimmed (the panel trims before it asks).
 */
export function groupNamesProblem(names: readonly string[]): "too-long" | "duplicate" | null {
  if (names.some((n) => n.length > MAX_GROUP_NAME)) return "too-long";
  const used = names.filter(Boolean).map((n) => n.toLowerCase());
  if (new Set(used).size !== used.length) return "duplicate";
  return null;
}

/** The list as stored: trimmed, and with trailing unnamed groups dropped so "nothing named" is `{}`. */
export function tidyGroupNames(names: readonly string[]): string[] {
  const out = names.map((n) => n.trim().replace(/\s+/g, " "));
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}
