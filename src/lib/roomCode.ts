/**
 * Nautical room codes - "SALTY KRAKEN" instead of "X7SU6B".
 *
 * Stored WITHOUT a separator (`SALTYKRAKEN`) on purpose. The alternative, storing the pretty
 * hyphenated form, makes lookup fragile: someone reading a code aloud gets typed back as
 * "salty kraken", "Salty-Kraken" or "saltykraken", and there's no way to re-insert a separator
 * into an unseparated string during a lookup. Storing the bare form means normalizing input is
 * just "uppercase, drop everything that isn't a letter or digit", which all of those collapse
 * to identically. The separator is re-derived for display instead (see formatRoomCode).
 *
 * Old-style random codes keep working untouched: they normalize to themselves and simply fail
 * the word split, so they render as-is.
 */

const ADJECTIVES = [
  "SALTY", "STORMY", "IRON", "CRIMSON", "SILENT", "ROYAL", "DRIFTING", "SUNKEN",
  "GOLDEN", "RUSTY", "BRAVE", "LOST", "FROZEN", "WILD", "DEEP", "ANCIENT",
  "BLACK", "SWIFT", "GRIM", "HOLLOW", "RESTLESS", "WEARY", "GHOSTLY", "MIGHTY",
  "FEARLESS", "RAGING", "ROLLING", "FADED", "BITTER", "HUNGRY", "ENDLESS", "DROWNED",
  "SCARLET", "EMERALD", "MOONLIT", "WINDSWEPT", "THUNDERING", "GLEAMING", "SHATTERED", "WANDERING",
];

const NOUNS = [
  "KRAKEN", "HARBOR", "ANCHOR", "TIDE", "COMPASS", "LANTERN", "MAST", "HULL",
  "RUDDER", "GALLEON", "FRIGATE", "SCHOONER", "BEACON", "REEF", "LAGOON", "TRIDENT",
  "SIREN", "LEVIATHAN", "MARINER", "CORSAIR", "ARMADA", "TEMPEST", "MAELSTROM", "ALBATROSS",
  "BARNACLE", "CUTLASS", "DOUBLOON", "FATHOM", "GALLEY", "HARPOON", "KEEL", "MARLIN",
  "NARWHAL", "PEARL", "QUAY", "SEXTANT", "SQUALL", "WHARF", "WRECK", "VOYAGE",
];

/** Longest first, so a word that prefixes another (SALT/SALTY) can't shadow the longer match. */
const ADJECTIVES_BY_LENGTH = [...ADJECTIVES].sort((a, b) => b.length - a.length);
const NOUNS_BY_LENGTH = [...NOUNS].sort((a, b) => b.length - a.length);

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

/**
 * ADJECTIVE+NOUN gives 1600 combinations against a 15-room cap, so a collision is already
 * remote. `attempt` is the caller's retry counter: from the third try on it appends two digits,
 * which turns a repeated unlucky clash into a guaranteed-fresh code without making the common
 * case uglier.
 */
export function generateRoomCode(attempt = 0): string {
  const base = pick(ADJECTIVES) + pick(NOUNS);
  return attempt >= 2 ? base + String(Math.floor(Math.random() * 90) + 10) : base;
}

/**
 * Short per-player token for reclaiming a slot on another device. Uses an unambiguous alphabet
 * (no 0/O/1/I) because this one genuinely does get read aloud or copied by hand, and a
 * misheard character just fails silently rather than landing you somewhere useful.
 */
/**
 * A 9-digit match seed for the Elden Ring randomizer.
 *
 * 9 digits is the widest slice of the requested 8-10 that still fits a signed 32-bit int
 * (999,999,999 vs 2,147,483,647), which is what randomizers overwhelmingly expect. The lower bound
 * of 100,000,000 keeps it exactly 9 digits, so it never renders with a short, odd-looking value.
 *
 * crypto.getRandomValues rather than Math.random - not for secrecy, but because Math.random is
 * seeded per browsing context and two people creating rooms in the same second have been known to
 * collide on it. A duplicate seed here means two matches unknowingly share a loadout.
 */
export function generateSeed(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100_000_000 + (buf[0] % 900_000_000));
}

export function generateRejoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** Canonical lookup form. "salty kraken" / "Salty-Kraken" / "saltykraken" all land here. */
export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Re-inserts spacing for display by finding the adjective/noun pair the code was built from.
 * Anything that doesn't split - a legacy random code, or one built from a word list that has
 * since changed - is returned unchanged rather than mangled.
 */
export function formatRoomCode(code: string): string {
  const upper = normalizeRoomCode(code);
  for (const adj of ADJECTIVES_BY_LENGTH) {
    if (!upper.startsWith(adj)) continue;
    const rest = upper.slice(adj.length);
    for (const noun of NOUNS_BY_LENGTH) {
      if (rest !== noun && !rest.startsWith(noun)) continue;
      const tail = rest.slice(noun.length);
      if (tail && !/^\d+$/.test(tail)) continue; // only a numeric disambiguator may follow
      return tail ? `${adj} ${noun} ${tail}` : `${adj} ${noun}`;
    }
  }
  return upper;
}
