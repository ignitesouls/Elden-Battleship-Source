/**
 * Regenerates the two derived tables that hang off the boss squares:
 *
 *   src/data/bossFlags.json    square tooltip -> the Elden Ring event flag set when that boss dies
 *   src/data/bossScaling.json  square tooltip -> that boss's progression number, 1-34
 *
 * Run it with `node scripts/build-boss-flags.mjs [path-to-overlay-data]` when the boss set changes
 * or the overlay ships new flag data. Nothing here runs at build time; the output is committed,
 * because it changes roughly never and the source lives outside this repo.
 *
 * -- Where the flags come from --------------------------------------------------------------------
 *
 * ignitesouls/er-overlay ships `data/<language>/bosses.json`, a list of every named boss with the
 * event flag the game sets on its death. Our square tooltips in battleshipChallenges.json are
 * literally `"{boss} - {place}"` from that same list, which is why most of this file is a join
 * rather than a hand-written table.
 *
 * That source is GPL-3.0 and lives outside this MIT repo, so it is read at generation time from a
 * path you pass in - never vendored. What gets committed is the derived table, keyed on OUR square
 * tooltips and holding only flag ids, which are facts about the game rather than anyone's authorship.
 *
 * -- Where the scaling comes from ------------------------------------------------------------------
 *
 * The same file, from a field we were already reading and throwing away. Every overlay boss name
 * carries a bracketed progression number - "[1] Soldier of Godrick", "[26] Rellana, Twin Moon
 * Knight" - which stripPrefix() removes before the join. It is er-overlay's own answer to "roughly
 * where in a run does this boss belong", which is the closest thing to a difficulty ordering that
 * exists for all 206 squares without anyone hand-authoring one.
 *
 * It is emitted here rather than by a sibling script precisely because it rides the SAME join. Two
 * scripts resolving 206 squares against the same source by the same four rules is two chances to
 * drift, and the failure would be a scaling table quietly keyed to the wrong bosses.
 *
 * Both tables are facts about the game read from a GPL-3.0 source at generation time, on identical
 * terms: an integer per boss, no text and no structure carried across.
 *
 * -- Why the join needs four rules ----------------------------------------------------------------
 *
 * The overlay's boss names carry display prefixes (`"[1] Soldier of Godrick"`, and for a handful
 * `"[Excpt.] [6] Grafted Scion"`) that have to come off first. After that:
 *
 *   1. Exact `{boss} - {place}` handles 157 of 206.
 *   2. Boss name alone handles another 19, where the overlay leaves `place` empty for major bosses
 *      and relies on its region grouping instead.
 *   3. Boss name plus the tooltip's own place text matched against the overlay's `region_name`
 *      handles 8 more. This exists because our region vocabulary is coarser than theirs - we have 7
 *      regions, they have 21, and our `dlc` alone spans eight of theirs.
 *   4. Everything left is an explicit override, listed below with the reasoning for each.
 *
 * -- Why nothing is guessed -----------------------------------------------------------------------
 *
 * A wrong flag fires a wrong square, and a shot cannot be taken back. So this script throws rather
 * than emitting a partial table: every one of the 206 squares must resolve, or the run fails and
 * says which ones didn't. There is deliberately no "skip the ones we couldn't work out" path.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where er-overlay's data folder sits. Override by passing a path as the first argument. */
const DEFAULT_SOURCE =
  "C:/Users/USER/Desktop/Elden Ring Mods/er-overlay-v0.2/data/engus";

const source = process.argv[2] ?? DEFAULT_SOURCE;
const SQUARES = join(root, "src", "data", "battleshipChallenges.json");
const OUT = join(root, "src", "data", "bossFlags.json");
const OUT_SCALING = join(root, "src", "data", "bossScaling.json");

/* --- overrides -------------------------------------------------------------
   Squares the four rules can't place on their own. Each carries its reasoning, because the whole
   value of this table is that a future reader can check the work rather than trusting it.

   The map-tile ones lean on a property of the flag ids themselves: `1044320800` encodes map tile
   44,32, so two same-named bosses in one region can be told apart by where they actually stand.

   ALL TWENTY CONFIRMED AGAINST THE GAME, 13 Aug 2026. Until then these were the only entries in the
   table derived by inference rather than an exact join, which mattered because auto-fire has no
   undo - a wrong flag fires a wrong square and the shot cannot be taken back. The reasoning below is
   kept as the derivation, not as the evidence; the evidence is that they were checked. */
const OVERRIDES = {
  // --- name variants: the overlay spells these differently, single unambiguous candidate each
  "Golden Godfrey": { flag: 11000850, why: "overlay: 'Godfrey, First Elden Lord' at Erdtree Sanctuary" },
  "Hoarah Loux": { flag: 11050800, why: "overlay: 'Godfrey, First Elden Lord' at Elden Throne" },
  "Promised Consort Radahn": { flag: 20010800, why: "overlay appends '& Radahn, Consort of Miquella'" },
  "Fell Twins": { flag: 34140850, why: "overlay: 'Fell Twin (x2)' at Divine Tower of East Altus" },
  "Lamenter": { flag: 41020800, why: "overlay: 'Lamenter' (no 'The') at Lamenter's Gaol" },

  // --- multi-instance bosses, separated by the map tile embedded in the flag id
  "LG Night Cav": { flag: 1043370800, why: "tile 43,37 - Limgrave proper; 1044320850 is Castle Morne Rampart" },
  "Forbidden Night Cav": { flag: 1048510800, why: "the only Night's Cavalry in Mountaintops, where Forbidden Lands sits" },
  "LG Deathbird": { flag: 1042380800, why: "tile 42,38 - Limgrave proper" },
  "Weeping Deathbird": { flag: 1044320800, why: "tile 44,32 - Weeping Peninsula, same tile as Castle Morne" },
  "Weeping Avatar": { flag: 1043330800, why: "tile 43,33 - Weeping Peninsula" },
  "MNTPS Avatar": { flag: 1052560800, why: "the Mountaintops Minor Erdtree avatar" },
  "Caelid Avatar": { flag: 1047400800, why: "tile 47,40 - western Caelid (confirmed)" },
  "Dragonbarrow Avatar": { flag: 1051400800, why: "tile 51,40 - eastern, i.e. Dragonbarrow (confirmed)" },
  "Liurnia Tibia": { flag: 1039440800, why: "the only Tibia Mariner in Liurnia" },
  "MNTPS Death Rite Bird": { flag: 1050570800, why: "the Mountaintops of the Giants one" },
  "Forbidden BBK": { flag: 1049520800, why: "Mountaintops Black Blade Kindred; the other is Bestial Sanctum, Caelid" },
  "Rot Dragonkin": { flag: 12010850, why: "the placeless Underground entry (confirmed)" },
  "Jagged Peak Drake": { flag: 2049410800, why: "the lone '[28]' drake, not the '(x2)' at Foot of the Jagged Peak (confirmed)" },

  // --- the Hinterlands pair: identical names, resolved in-game
  //     Killing the torch sentinel ticked the FIRST of the two rows in the overlay's checklist, and
  //     that checklist renders in data-file order. Corroborated by the tiles: 50,47 and 50,48, with
  //     the surviving shield sentinel visible to the north, i.e. the higher tile.
  "HL Tree Sent Torch": { flag: 2050470800, why: "in-game: first checklist row ticked on the torch kill; tile 50,47" },
  "HL Tree Sent Shield": { flag: 2050480860, why: "in-game: the survivor, to the north; tile 50,48" },
};

/* --- helpers --------------------------------------------------------------- */

/**
 * The overlay's display prefix: an optional "[Excpt.]" marker, then a bracketed progression number.
 * "[Excpt.] [6] Grafted Scion" -> exception marker, 6, "Grafted Scion".
 */
const PREFIX = /^\s*(?:\[Excpt\.\]\s*)?(?:\[(\d+)\]\s*)?/i;

/** Strips the overlay's display prefixes: "[Excpt.] [6] Grafted Scion" -> "Grafted Scion". */
const stripPrefix = (s) => String(s).replace(PREFIX, "").trim();

/** The bracketed progression number, or null for a boss the overlay left unnumbered. */
const scalingOf = (s) => {
  const n = String(s).match(PREFIX)?.[1];
  return n === undefined ? null : Number(n);
};

/** Comparison key that survives punctuation drift - "Chief(x2)" vs "Chief (x2)". */
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `Couldn't read ${path}\n\n` +
          `Point this script at er-overlay's data/<language> folder:\n` +
          `  node scripts/build-boss-flags.mjs "path/to/er-overlay/data/engus"`
      );
    }
    throw err;
  }
}

/* --- load the flag source ---------------------------------------------------
   bosses.json already contains every DLC flag, but bosses_dlc.json carries richer `place` text for
   those same entries. So: merge both, dedupe by flag id, and keep whichever record names a place. */

function loadFlags(dir) {
  const byFlag = new Map();
  for (const file of ["bosses.json", "bosses_dlc.json"]) {
    for (const region of readJson(join(dir, file))) {
      for (const boss of region.bosses ?? []) {
        const rec = {
          boss: stripPrefix(boss.boss),
          place: boss.place ?? "",
          region: region.region_name ?? "",
          flag: boss.flag_id,
          scaling: scalingOf(boss.boss),
        };
        const existing = byFlag.get(rec.flag);
        if (!existing || (!existing.place && rec.place)) {
          // Keep a number we already have if the winning record happens not to carry one - the two
          // files describe the same bosses and only one of them needs to have been numbered.
          if (rec.scaling === null && existing) rec.scaling = existing.scaling;
          byFlag.set(rec.flag, rec);
        }
      }
    }
  }
  return [...byFlag.values()];
}

/* --- the join --------------------------------------------------------------- */

function resolve(square, flags, exact) {
  const tooltip = square.tooltip ?? "";
  const bossPart = norm(tooltip.split(" - ")[0] ?? "");
  const placePart = tooltip.split(" - ").slice(1).join(" - ");

  const hit = exact.get(norm(tooltip));
  if (hit !== undefined) return { flag: hit, rule: "exact" };

  const byName = flags.filter((f) => norm(f.boss) === bossPart);
  if (byName.length === 1) return { flag: byName[0].flag, rule: "boss name" };

  // Our `dlc` region covers eight of theirs, so match the tooltip's own place text against their
  // region name rather than against our coarse region tag.
  const byRegion = byName.filter(
    (f) => norm(f.region) === norm(placePart) || norm(placePart).includes(norm(f.region))
  );
  if (byRegion.length === 1) return { flag: byRegion[0].flag, rule: "boss + region" };

  return null;
}

/* --- run -------------------------------------------------------------------- */

const flags = loadFlags(source);
const exact = new Map(flags.map((f) => [norm(`${f.boss} - ${f.place}`), f.flag]));
const squares = readJson(SQUARES);
const known = new Set(flags.map((f) => f.flag));
const scalingByFlag = new Map(flags.map((f) => [f.flag, f.scaling]));

const table = {};
const scaling = {};
const counts = { exact: 0, "boss name": 0, "boss + region": 0, override: 0 };
const unresolved = [];
const unscaled = [];
const collisions = [];

for (const square of squares) {
  const tooltip = square.tooltip ?? "";
  const override = OVERRIDES[square.name];

  let flag;
  if (override) {
    // An override naming a flag the source doesn't have means the source moved under us - louder
    // failure than silently writing an id that will never fire.
    if (!known.has(override.flag)) {
      throw new Error(`Override for "${square.name}" names flag ${override.flag}, absent from ${source}`);
    }
    flag = override.flag;
    counts.override++;
  } else {
    const found = resolve(square, flags, exact);
    if (!found) {
      unresolved.push(`${square.name.padEnd(30)} | ${tooltip}`);
      continue;
    }
    flag = found.flag;
    counts[found.rule]++;
  }

  if (table[tooltip] !== undefined && table[tooltip] !== flag) {
    collisions.push(`${tooltip} -> ${table[tooltip]} and ${flag}`);
  }
  table[tooltip] = flag;

  // Rides the flag the join just settled on, so the two tables cannot disagree about which overlay
  // boss a square is. An override picks its flag deliberately; the number follows that same choice.
  const n = scalingByFlag.get(flag);
  if (n === null || n === undefined) unscaled.push(`${square.name.padEnd(30)} | ${tooltip}`);
  else scaling[tooltip] = n;
}

if (unresolved.length) {
  throw new Error(
    `${unresolved.length} square(s) have no flag. Add an override with its reasoning, or confirm the\n` +
      `boss in-game using the overlay checklist (kill it, see which row ticks, read the id at that\n` +
      `position in bosses.json).\n\n  ${unresolved.join("\n  ")}`
  );
}
if (collisions.length) {
  throw new Error(`Tooltip mapped to two different flags:\n  ${collisions.join("\n  ")}`);
}
/* Same no-partial-tables rule the flags follow, for the same reason. A missing scaling number is not
   a square that quietly scores zero: the balancer weighs fleets against each other, so one square
   silently reading as the easiest boss in the game would tilt every board it lands on. */
if (unscaled.length) {
  throw new Error(
    `${unscaled.length} square(s) resolved to a flag with no [N] progression number. The overlay\n` +
      `numbers every boss, so this means the source changed shape - check whether bosses.json still\n` +
      `prefixes names like "[1] Soldier of Godrick".\n\n  ${unscaled.join("\n  ")}`
  );
}

/* Two squares legitimately sharing one flag would mean one kill fires both. Nothing in the boss set
   does this today, but it is the kind of thing that appears quietly when squares are edited, so it
   is reported rather than left to be discovered mid-match. */
const perFlag = new Map();
for (const [tooltip, flag] of Object.entries(table)) {
  if (!perFlag.has(flag)) perFlag.set(flag, []);
  perFlag.get(flag).push(tooltip);
}
const shared = [...perFlag.entries()].filter(([, tips]) => tips.length > 1);

const output = {
  // Matches the `_`-prefixed comment convention already used by incursionRegions.json and friends.
  _comment: [
    "GENERATED by scripts/build-boss-flags.mjs - do not edit by hand.",
    "Maps a boss square's tooltip to the Elden Ring event flag set when that boss dies.",
    "Flag ids sourced from ignitesouls/er-overlay (GPL-3.0) data/engus/bosses.json at generation time.",
    "Every entry is either an exact join or an explicit override with stated reasoning; none are guessed.",
  ],
  ...table,
};

const scalingOutput = {
  _comment: [
    "GENERATED by scripts/build-boss-flags.mjs - do not edit by hand.",
    "Maps a boss square's tooltip to er-overlay's progression number for that boss, 1-34.",
    "Read from the bracketed prefix on its boss name in data/engus/bosses.json (GPL-3.0) at generation time.",
    "Used only to weigh fleets against each other when a board is balanced; it is never shown to players.",
    "Rides the same square->flag join as bossFlags.json, so the two tables always describe the same boss.",
  ],
  ...scaling,
};

writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(OUT_SCALING, `${JSON.stringify(scalingOutput, null, 2)}\n`);

const range = Object.values(scaling);
console.log(`source   ${source}`);
console.log(`flags    ${flags.length} distinct`);
console.log(`squares  ${squares.length}`);
console.log(
  `  exact ${counts.exact}  |  boss name ${counts["boss name"]}  |  boss+region ${counts["boss + region"]}  |  override ${counts.override}`
);
console.log(`scaling  ${range.length} squares, [${Math.min(...range)}-${Math.max(...range)}]`);
if (shared.length) {
  console.log(`\n${shared.length} flag(s) shared by multiple squares - one kill fires several:`);
  for (const [flag, tips] of shared) console.log(`  ${flag}: ${tips.join(" | ")}`);
}
console.log(`\nwrote ${OUT}`);
console.log(`wrote ${OUT_SCALING}`);
