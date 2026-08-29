/**
 * One cache, shared by everything that reads the record books.
 *
 * This lived inside lib/profiles while the three stats feeds were its only users. It is its own
 * module now because the history list in lib/matchArchive wants it too, and the alternative - a
 * second cache with its own timer and its own clear function - is how two caches end up disagreeing
 * about whether a just-finished match exists.
 *
 * Most of what is cached here reads the four archive tables, which are immutable apart from one
 * event: a match ending. So the only thing this can get wrong is being a few minutes late to a
 * match that has just been archived, and clearArchiveCache covers the case where this tab is the
 * one that archived it. An admin voiding or deleting a match clears it too - see lib/admin.
 *
 * The one entry that is NOT an archive table is the profile lookup the same three pages do to put
 * names and avatars on those rows. It is genuinely mutable - somebody can rename themselves - so it
 * is dropped on its own by the rename path rather than waiting out the five minutes. That is what
 * `forget` is for, and it is why renaming does not have to throw away the archive feeds too.
 */

/**
 * How long a fetched feed is reused before it is read again.
 *
 * What it buys is the whole reason it exists: Almanac, Leaderboard and PlayerStats each read the
 * same feeds on mount, so a visitor who looks at all three used to download the entire archive
 * three times over. Five minutes comfortably covers somebody clicking between them, and expires
 * well inside the pace matches actually finish at.
 */
const ARCHIVE_CACHE_MS = 5 * 60 * 1000;

const archiveCache = new Map<string, { at: number; rows: Promise<unknown[]> }>();

/**
 * The cached read, or a fresh one.
 *
 * Caches the PROMISE rather than the rows, so the two fetches Leaderboard and PlayerStats kick off
 * in the same tick share one request instead of both missing and both going to the network - the
 * same reason fetchVoidedMatches holds a promise rather than a Set.
 *
 * A read that fails or comes back empty is evicted rather than kept, so a network blip costs one
 * page load rather than five minutes of a site that believes it has no history.
 */
export function cached<T>(key: string, read: () => Promise<T[]>): Promise<T[]> {
  const hit = archiveCache.get(key);
  if (hit && Date.now() - hit.at < ARCHIVE_CACHE_MS) return hit.rows as Promise<T[]>;

  const rows = read().then(
    (r) => {
      if (r.length === 0) archiveCache.delete(key);
      return r;
    },
    (e) => {
      archiveCache.delete(key);
      throw e;
    }
  );
  archiveCache.set(key, { at: Date.now(), rows: rows as Promise<unknown[]> });
  return rows;
}

/** Forgets every cached feed, so a tab that has just archived a match sees it in the stats. */
export function clearArchiveCache(): void {
  archiveCache.clear();
}

/**
 * Forgets one family of keys, named by prefix.
 *
 * So that a write which invalidates ONE thing does not cost a re-download of everything else. The
 * rename path uses it: a new nickname must show up at once, and making that re-fetch the whole
 * event log as well would be a strictly worse trade than the staleness it fixes.
 */
export function forget(prefix: string): void {
  for (const key of [...archiveCache.keys()]) {
    if (key.startsWith(prefix)) archiveCache.delete(key);
  }
}
