import { headToHeadRecords, participantKey, teammateRecords, type ParticipantRow } from "./careerStats";
import { archivedShots, MIN_GAP_SECONDS } from "./recordBook";
import { paceFromGaps, paceLabel } from "./squarePace";
import { matchMs } from "./matchReport";
import type { MatchEventRow } from "./almanac";
import type { FeedShot } from "./attackFeed";
import type { SquareBoard } from "./battleRatingBoards";
import type { PauseFields } from "./matchPause";
import type { Language } from "./language";

/**
 * Talking points: things a caster can say about the people on the board, worked out for them.
 *
 * Two kinds, drawn as two lists on the desk:
 *
 *   before the match   history brought into it - head-to-head records, go-to squares, usual openers,
 *                      world records held. Settled once the roster is, so worked out once.
 *   live               things that just happened, measured against that history - a personal best, a
 *                      world record falling, a first-ever kill, a square well off its usual pace.
 *                      Re-read on every shot.
 *
 * Neither costs a request of its own once the desk has the history: the live half reads the shots the
 * desk is already sent to draw the board. See hooks/useTalkingPoints for the reads.
 *
 * Every timing here is the record book's: a square's fight is the gap back to that captain's previous
 * shot, both ends auto-fired, and at least MIN_GAP_SECONDS long (see almanac.timedSquares and
 * squarePace). So a live "personal best" is the same measurement the career page's best kills list
 * makes, and a live world record is one the Almanac would agree with once the match is archived. A
 * manually-clicked square produces no timing point at all, rather than a wrong one.
 *
 * -- Two ways of saying each one, in two languages ----------------------------------------------------
 *
 * `text` is the desk's: terse, every number, for a caster to read at a glance. `line` is the barnacle's,
 * said in the speech bubble when the caster puts the point on stream: short, loud and fun - "That's the
 * fastest Ada has ever killed Malenia!" The voice is deliberate and lives only in the `line`s below, so a
 * change of tone is an edit to those strings and nothing else.
 *
 * Both are written in the desk's language (Voice), English and French side by side the way `t()` puts
 * them everywhere else - so a French cast gets a French barnacle. The French never guesses a player's
 * gender: lines are built around the name, the boss, or a possessive that agrees with the thing owned.
 * Square names go through Voice.square, which gives the French name where the set has one.
 */

/**
 * Which barnacle says it, when it goes on stream (public/media/barnacles):
 *
 *   happy   something went right - a record, a personal best, a first, a quick square, a newcomer
 *   smug    history brought in - records against people, habits, records held
 *   grim    something going wrong - a slow square, a losing record against tonight's opponent
 *   angry   so close - a world record missed by seconds, or tied and not taken
 */
export type BarnacleMood = "happy" | "smug" | "grim" | "angry";

export interface TalkingPoint {
  /** Stable across re-reads, so a list re-rendered on every shot does not reshuffle its keys. */
  id: string;
  emoji: string;
  mood: BarnacleMood;
  /** Whose point it is, for the colour. Null for one about the whole matchup. */
  team: number | null;
  /** The desk's version: terse, every number. */
  text: string;
  /** The barnacle's version, for the speech bubble on stream. */
  line: string;
  /** Match-clock milliseconds of the shot behind a live point - newest first on the desk. */
  at?: number;
  /** A big moment - a world record, a personal best - drawn in the accent colour. */
  big?: boolean;
  /** The player it is about, so the desk can put it over their box. Absent on a crew-wide point. */
  playerId?: string;
  /** Wall time of the shot behind a live point, so a card over the box waits for the stream to show it. */
  shotAt?: string;
}

/** One captain on the board, keyed the way the archive keys careers. */
export interface RosterEntry {
  playerId: string;
  key: string;
  nickname: string;
  team: number;
}

/** Square name -> its standing times. See squareRecords in battleRatingBoards. */
export type SquareRecords = Record<string, SquareBoard>;

/** The language the points are written in, and how a square's (English, archived) name is said in it. */
export interface Voice {
  lang: Language;
  square: (name: string) => string;
}

const ENGLISH: Voice = { lang: "en", square: (name) => name };

/** What one captain has done on this board before, boiled down to what the points read. */
export interface PlayerHistory {
  key: string;
  /** Matches with at least one shot on this board. */
  matches: number;
  /** Square -> times taken. */
  takes: Map<string, number>;
  /** Square -> matches it was the opening shot of. */
  openers: Map<string, number>;
  /** Square -> every timed fight on it, in seconds. */
  gaps: Map<string, number[]>;
  /** Median seconds per square across everything, or null on too few - squarePace's rule. */
  pace: number | null;
}

/** History needed before a "first time ever" is news rather than a newcomer's every square. */
export const FIRSTS_AFTER_MATCHES = 3;
/** Timed fights on a square before "usual" means anything - one bad night is not a habit. */
export const USUAL_AFTER_FIGHTS = 3;
/** Timed fights on a square, by everyone, before "the global average" means anything. */
export const GLOBAL_AFTER_FIGHTS = 5;
/** Kill counts worth calling out. */
export const MILESTONES = [5, 10, 25, 50, 100, 250];
/** How far off a usual time a square must be to be worth saying: this many seconds, or this share of it. */
const PACE_GAP = { seconds: 30, share: 0.25 };
/** How close to a world record counts as "just off it": this many seconds, or this share of it. */
const NEAR_RECORD = { seconds: 10, share: 0.1 };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const clock = paceLabel;
const record = (w: number, l: number, d: number) => (d > 0 ? `${w}-${l}-${d}` : `${w}-${l}`);

/** The language-dependent words, built once per call from the Voice. */
function phrasebook(voice: Voice) {
  const fr = voice.lang === "fr";
  return {
    tr: (en: string, frText: string) => (fr ? frText : en),
    /** "3rd" / "3e". French agrees with what it counts: "la 1re fois", "le 1er" - `feminine` picks. */
    ordinal: (n: number, feminine = false) => {
      if (fr) return n === 1 ? (feminine ? "1re" : "1er") : `${n}e`;
      const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
      return `${n}${tail}`;
    },
    times: (n: number) => (fr ? (n === 1 ? "une fois" : `${n} fois`) : n === 1 ? "once" : `${n} times`),
    matches: (n: number) => (fr ? `${n} ${n === 1 ? "match" : "matchs"}` : `${n} ${n === 1 ? "match" : "matches"}`),
  };
}

/**
 * Where a fight would place among every fight ever on its square: 1 is the fastest. Null past the
 * tenth, which the snapshot does not keep - and which is not worth saying out loud anyway. A tie
 * shares the place it ties, as the record book's first-holder rule would have it.
 */
export function allTimeRank(board: SquareBoard | undefined, seconds: number): number | null {
  if (!board) return null;
  const faster = board.top.filter((s) => s < seconds).length;
  if (faster < board.top.length) return faster + 1;
  // Slower than everything kept: a place only when the whole square's history fits in the list.
  return board.fights <= board.top.length ? faster + 1 : null;
}

/** Biggest count first, ties alphabetical so the list holds still between re-reads. */
function ranked(counts: Map<string, number>): [string, number][] {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * One captain's history, from their own shots on this board.
 *
 * @param events their archived shots, already narrowed to them and to this board's square set.
 */
export function playerHistory(events: MatchEventRow[], key: string): PlayerHistory {
  const takes = new Map<string, number>();
  const openers = new Map<string, number>();
  const gaps = new Map<string, number[]>();
  const matches = new Set<string>();
  const previous = new Map<string, { seconds: number; auto: boolean }>();

  // archivedShots orders by match, then by time - the order both an opener and a gap are read in.
  for (const shot of archivedShots(events.filter((e) => participantKey(e) === key))) {
    const before = previous.get(shot.matchKey);
    previous.set(shot.matchKey, { seconds: shot.seconds, auto: shot.auto });
    matches.add(shot.matchKey);
    if (!shot.challenge) continue;

    takes.set(shot.challenge, (takes.get(shot.challenge) ?? 0) + 1);
    if (before === undefined) {
      openers.set(shot.challenge, (openers.get(shot.challenge) ?? 0) + 1);
      continue;
    }
    if (!before.auto || !shot.auto) continue;
    const gap = shot.seconds - before.seconds;
    if (gap < MIN_GAP_SECONDS) continue;
    const list = gaps.get(shot.challenge);
    if (list) list.push(gap);
    else gaps.set(shot.challenge, [gap]);
  }

  return { key, matches: matches.size, takes, openers, gaps, pace: paceFromGaps([...gaps.values()].flat()) };
}

const emptyHistory = (key: string): PlayerHistory => ({
  key,
  matches: 0,
  takes: new Map(),
  openers: new Map(),
  gaps: new Map(),
  pace: null,
});

/**
 * What to say before a shot is fired.
 *
 * @param parts every participation row on this board - the desk already holds them for the record chase.
 * @param histories each captain's history, by key. A captain missing from it reads as brand new.
 * @param boardSquares the squares on tonight's board, so "go-to squares" only names ones that are here.
 * @param teamLabel how the desk names a fleet.
 */
export function matchupPoints(
  roster: RosterEntry[],
  parts: ParticipantRow[],
  histories: Map<string, PlayerHistory>,
  records: SquareRecords,
  boardSquares: ReadonlySet<string>,
  teamLabel: (team: number) => string,
  voice: Voice = ENGLISH
): TalkingPoint[] {
  const { tr, times, matches } = phrasebook(voice);
  const sq = voice.square;
  const out: TalkingPoint[] = [];
  const teams = [...new Set(roster.map((r) => r.team))].sort((a, b) => a - b);
  const crews = new Map(teams.map((t) => [t, roster.filter((r) => r.team === t)]));

  // -- The crews against each other ------------------------------------------------------------
  // A past match counts as a meeting when one fleet held every one of tonight's crew A and another
  // held every one of crew B - the same crews, whatever else was on the board.
  const byMatch = new Map<string, ParticipantRow[]>();
  for (const p of parts) {
    const list = byMatch.get(p.match_key);
    if (list) list.push(p);
    else byMatch.set(p.match_key, [p]);
  }
  const fleetOf = (rows: ParticipantRow[], crew: RosterEntry[]): ParticipantRow | null => {
    const first = rows.find((r) => participantKey(r) === crew[0].key);
    if (!first) return null;
    const all = crew.every((c) => rows.some((r) => r.team === first.team && participantKey(r) === c.key));
    return all ? first : null;
  };
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const a = crews.get(teams[i])!;
      const b = crews.get(teams[j])!;
      let met = 0;
      let aWins = 0;
      let bWins = 0;
      for (const rows of byMatch.values()) {
        const fa = fleetOf(rows, a);
        const fb = fleetOf(rows, b);
        if (!fa || !fb || fa.team === fb.team) continue;
        met++;
        if (fa.won && !fa.draw) aWins++;
        if (fb.won && !fb.draw) bWins++;
      }
      const [na, nb] = [teamLabel(teams[i]), teamLabel(teams[j])];
      const known = [...a, ...b].some((r) => (histories.get(r.key)?.matches ?? 0) > 0);
      const id = `crews:${teams[i]}:${teams[j]}`;
      if (met > 0) {
        const drawn = met - aWins - bWins;
        const lead = aWins === bWins ? null : aWins > bWins ? ([na, aWins, bWins] as const) : ([nb, bWins, aWins] as const);
        out.push({
          id,
          emoji: "⚔️",
          mood: "smug",
          team: null,
          text: tr(
            `${na} vs ${nb}: met ${times(met)} before - ${na} ${aWins}, ${nb} ${bWins}${drawn > 0 ? `, ${drawn} drawn` : ""}`,
            `${na} contre ${nb} : déjà ${times(met)} - ${na} ${aWins}, ${nb} ${bWins}${drawn > 0 ? `, ${drawn} ${drawn === 1 ? "nul" : "nuls"}` : ""}`
          ),
          line: lead
            ? tr(
                `${na} and ${nb} have clashed ${times(met)} - ${lead[0]} leads ${lead[1]} to ${lead[2]}!`,
                `${na} et ${nb} se sont affrontés ${times(met)} - ${lead[0]} mène ${lead[1]} à ${lead[2]} !`
              )
            : tr(
                `${na} and ${nb} have clashed ${times(met)} - dead even at ${aWins} apiece!`,
                `${na} et ${nb} se sont affrontés ${times(met)} - égalité parfaite, ${aWins} partout !`
              ),
        });
      } else if (known) {
        out.push({
          id,
          emoji: "⚔️",
          mood: "happy",
          team: null,
          text: tr(`${na} vs ${nb}: first time these crews have met`, `${na} contre ${nb} : première rencontre de ces équipages`),
          line: tr(`${na} vs ${nb} - first time these crews have EVER met!`, `${na} contre ${nb} - la toute PREMIÈRE rencontre de ces équipages !`),
        });
      }
    }
  }

  // -- Captain against captain, and crewmates ----------------------------------------------------
  // Each pair once, from the lower fleet's side, busiest rivalry first.
  const rivals: { played: number; point: TalkingPoint }[] = [];
  for (const a of roster) {
    const h2h = headToHeadRecords(parts, a.key);
    const mates = teammateRecords(parts, a.key);
    for (const b of roster) {
      if (b.key === a.key) continue;
      if (b.team > a.team) {
        const r = h2h.find((h) => h.key === b.key);
        if (r && r.played > 0) {
          const rec = record(r.wins, r.losses, r.draws);
          rivals.push({
            played: r.played,
            point: {
              id: `h2h:${a.key}:${b.key}`,
              emoji: "🤺",
              // Said from a's side: a winning record is a boast, a losing one a worry.
              mood: r.wins >= r.losses ? "smug" : "grim",
              team: a.team,
              playerId: a.playerId,
              text: tr(`${a.nickname} is ${rec} against ${b.nickname}`, `${a.nickname} est à ${rec} contre ${b.nickname}`),
              line:
                r.wins > r.losses
                  ? tr(
                      `${a.nickname} is ${rec} against ${b.nickname} - can ${b.nickname} turn it around?!`,
                      `${a.nickname} est à ${rec} contre ${b.nickname} - à ${b.nickname} de renverser la vapeur !`
                    )
                  : r.wins < r.losses
                    ? tr(
                        `${a.nickname} is ${rec} against ${b.nickname} - revenge tonight?!`,
                        `${a.nickname} est à ${rec} contre ${b.nickname} - l'heure de la revanche ?!`
                      )
                    : tr(
                        `${a.nickname} and ${b.nickname} are dead even at ${rec}!`,
                        `${a.nickname} et ${b.nickname} : égalité parfaite, ${rec} !`
                      ),
            },
          });
        }
      } else if (b.team === a.team && b.key > a.key) {
        const r = mates.find((m) => m.key === b.key);
        if (r && r.played >= 2) {
          const rec = record(r.wins, r.losses, r.played - r.wins - r.losses);
          rivals.push({
            played: r.played,
            point: {
              id: `mates:${a.key}:${b.key}`,
              emoji: "🤝",
              mood: r.wins >= r.losses ? "smug" : "grim",
              team: a.team,
              playerId: a.playerId,
              text: tr(`${a.nickname} and ${b.nickname}: ${rec} as crewmates`, `${a.nickname} et ${b.nickname} : ${rec} dans le même équipage`),
              line: tr(`${a.nickname} and ${b.nickname} are ${rec} sailing together!`, `${a.nickname} et ${b.nickname} : ${rec} sur le même navire !`),
            },
          });
        }
      }
    }
  }
  rivals.sort((x, y) => y.played - x.played);
  out.push(...rivals.slice(0, 8).map((r) => r.point));

  // -- Each captain ------------------------------------------------------------------------------
  for (const r of [...roster].sort((x, y) => x.team - y.team || x.nickname.localeCompare(y.nickname))) {
    const from = out.length;
    captain(r);
    // Everything just said is about this captain, so any of it can go over their box.
    for (let i = from; i < out.length; i++) out[i].playerId = r.playerId;
  }

  return out;

  function captain(r: RosterEntry): void {
    const h = histories.get(r.key) ?? emptyHistory(r.key);
    const mine = parts.filter((p) => participantKey(p) === r.key);
    const who = r.nickname;
    if (mine.length === 0 && h.matches === 0) {
      out.push({
        id: `career:${r.key}`,
        emoji: "🆕",
        mood: "happy",
        team: r.team,
        text: tr(`${who}: first match on this board`, `${who} : premier match sur ce plateau`),
        line: tr(`First voyage on this board for ${who} - welcome aboard!`, `Première traversée sur ce plateau pour ${who} - bienvenue à bord !`),
      });
      return;
    }

    const wins = mine.filter((p) => p.won && !p.draw).length;
    const draws = mine.filter((p) => p.draw).length;
    const rec = record(wins, mine.length - wins - draws, draws);
    const pace = h.pace !== null ? clock(h.pace) : null;
    out.push({
      id: `career:${r.key}`,
      emoji: "📜",
      mood: wins >= mine.length - wins - draws ? "smug" : "grim",
      team: r.team,
      text: tr(
        `${who}: ${matches(mine.length)} on this board, ${rec}${pace ? `, ${pace} a square` : ""}`,
        `${who} : ${matches(mine.length)} sur ce plateau, ${rec}${pace ? `, ${pace} par case` : ""}`
      ),
      line: tr(
        `${who} has sailed ${matches(mine.length)} here and won ${wins}${pace ? ` - ${pace} a square!` : "!"}`,
        `${who} a disputé ${matches(mine.length)} ici et en a gagné ${wins}${pace ? ` - ${pace} par case !` : " !"}`
      ),
    });

    const goTo = ranked(h.takes).filter(([s, n]) => n >= 2 && boardSquares.has(s)).slice(0, 3);
    if (goTo.length > 0) {
      const [[fav, n]] = goTo;
      const list = goTo.map(([s, k]) => `${sq(s)} (${k})`).join(", ");
      out.push({
        id: `goto:${r.key}`,
        emoji: "🎯",
        mood: "smug",
        team: r.team,
        text: tr(`${who}'s go-to squares here tonight: ${list}`, `Cases fétiches de ${who} ce soir : ${list}`),
        line: tr(
          `${who} LOVES ${sq(fav)} - killed it ${times(n)} all time, and it's on the board tonight!`,
          `${who} ADORE ${sq(fav)} - déjà ${times(n)} au total, et c'est au programme ce soir !`
        ),
      });
    }

    const [opener] = ranked(h.openers);
    if (opener && opener[1] >= 2) {
      const here = boardSquares.has(opener[0]);
      const op = sq(opener[0]);
      out.push({
        id: `opener:${r.key}`,
        emoji: "🚩",
        mood: "smug",
        team: r.team,
        text: tr(
          `${who} usually opens on ${op} (${opener[1]} of ${h.matches}) - ${here ? "and it's on the board" : "not on the board tonight"}`,
          `${who} ouvre souvent sur ${op} (${opener[1]} sur ${h.matches}) - ${here ? "et c'est sur le plateau" : "absent du plateau ce soir"}`
        ),
        line: here
          ? tr(
              `${who} loves to open with ${op} - ${times(opener[1])} all time, and it's right there tonight!`,
              `${who} adore ouvrir avec ${op} - ${times(opener[1])} au total, et c'est au programme ce soir !`
            )
          : tr(
              `${who} loves to open with ${op} - but it's not on the board tonight!`,
              `${who} adore ouvrir avec ${op} - mais pas de chance, absent du plateau ce soir !`
            ),
      });
    }

    let quickest: [string, number] | null = null;
    for (const [s, list] of h.gaps) {
      if (!boardSquares.has(s)) continue;
      const best = Math.min(...list);
      if (!quickest || best < quickest[1]) quickest = [s, best];
    }
    if (quickest) {
      const [qs, qt] = [sq(quickest[0]), clock(quickest[1])];
      out.push({
        id: `quickest:${r.key}`,
        emoji: "⏱️",
        mood: "smug",
        team: r.team,
        text: tr(`${who}'s quickest square on this board: ${qs} in ${qt}`, `Case la plus rapide de ${who} sur ce plateau : ${qs} en ${qt}`),
        line: tr(
          `Watch ${who} on ${qs} - a ${qt} kill, their fastest on tonight's board!`,
          `Attention à ${who} sur ${qs} - ${qt}, son meilleur temps sur le plateau de ce soir !`
        ),
      });
    }

    const held = Object.entries(records)
      .filter(([s, board]) => boardSquares.has(s) && board.holders[0]?.key === r.key)
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (held.length > 0) {
      const list = held.map(([s, board]) => `${sq(s)} (${clock(board.holders[0].seconds)})`).join(", ");
      out.push({
        id: `wr-held:${r.key}`,
        emoji: "🌍",
        mood: "smug",
        team: r.team,
        big: true,
        text: tr(`${who} holds the world record on ${list}`, `${who} détient le record du monde sur ${list}`),
        line: tr(
          `${who} holds the WORLD RECORD on ${list} - can anyone take it tonight?!`,
          `${who} détient le RECORD DU MONDE sur ${list} - quelqu'un va-t-il le battre ce soir ?!`
        ),
      });
    }
  }
}

/**
 * What just happened, newest first.
 *
 * @param shots this match's shots, as groupIntoShots gives them (any order).
 * @param squareAt the square under a cell on tonight's board, by its English (archived) name.
 * @param pause the room's pause columns, so a fight spanning a stopped clock is not timed as slow.
 */
export function livePoints(
  roster: RosterEntry[],
  shots: FeedShot[],
  squareAt: (cell: number) => string | null,
  histories: Map<string, PlayerHistory>,
  records: SquareRecords,
  pause?: PauseFields | null,
  voice: Voice = ENGLISH
): TalkingPoint[] {
  const { tr, ordinal } = phrasebook(voice);
  /** " (3rd fastest all time)", or nothing when it is not a top-ten fight - or is the outright fastest. */
  const rankTag = (rank: number | null) =>
    rank === null || rank === 1 ? "" : tr(` (${ordinal(rank)} fastest all time)`, ` (${ordinal(rank)} plus rapide de tous les temps)`);

  const out: TalkingPoint[] = [];
  const byPlayer = new Map(roster.map((r) => [r.playerId, r]));
  const previous = new Map<string, { seconds: number; auto: boolean }>();
  const takenTonight = new Map<string, number>();

  const inOrder = [...shots].sort((a, b) => matchMs(a.at, pause) - matchMs(b.at, pause));
  for (const shot of inOrder) {
    const who = byPlayer.get(shot.rows[0]?.attacker_player_id ?? "");
    if (!who) continue;
    const at = matchMs(shot.at, pause);
    const seconds = at / 1000;
    const auto = shot.rows.every((r) => r.auto === true);
    const before = previous.get(who.key);
    previous.set(who.key, { seconds, auto });
    const square = squareAt(shot.cellIndex);
    if (!square) continue;

    const h = histories.get(who.key) ?? emptyHistory(who.key);
    const name = who.nickname;
    const sq = voice.square(square);
    const say = (kind: string, emoji: string, mood: BarnacleMood, text: string, line: string, big = false) =>
      out.push({ id: `${shot.key}:${kind}`, emoji, mood, team: who.team, text, line, at, big, playerId: who.playerId, shotAt: shot.at });
    const tonight = (takenTonight.get(`${who.key}|${square}`) ?? 0) + 1;
    takenTonight.set(`${who.key}|${square}`, tonight);
    const career = (h.takes.get(square) ?? 0) + tonight;

    // -- The opening shot, against their habit --------------------------------------------------
    if (before === undefined && h.matches >= FIRSTS_AFTER_MATCHES) {
      const [usual] = ranked(h.openers);
      if (usual && usual[1] >= 2) {
        const usualSq = voice.square(usual[0]);
        if (usual[0] === square) {
          say(
            "opener",
            "🚩",
            "smug",
            tr(
              `${name} opens on ${sq} - the usual opener (${usual[1]} of ${h.matches})`,
              `${name} ouvre sur ${sq} - l'ouverture habituelle (${usual[1]} sur ${h.matches})`
            ),
            tr(
              `${name} loves to open with ${sq} - that's the ${ordinal(usual[1] + 1)} time they've done it (all time)!`,
              `${name} adore ouvrir avec ${sq} - c'est la ${ordinal(usual[1] + 1, true)} fois (au total) !`
            )
          );
        } else {
          say(
            "opener",
            "🚩",
            "smug",
            tr(
              `${name} opens on ${sq}, not the usual ${usualSq} (${usual[1]} of ${h.matches})`,
              `${name} ouvre sur ${sq}, et non sur ${usualSq} comme d'habitude (${usual[1]} sur ${h.matches})`
            ),
            tr(
              `${name} opens with ${sq}?! They usually go straight for ${usualSq}!`,
              `${name} ouvre avec ${sq} ?! D'habitude, c'est direct sur ${usualSq} !`
            )
          );
        }
      }
    }

    // -- Firsts and round numbers ---------------------------------------------------------------
    if (career === 1 && h.matches >= FIRSTS_AFTER_MATCHES) {
      say(
        "first",
        "✨",
        "happy",
        tr(
          `First ${sq} of ${name}'s career on this board (${h.matches} matches in)`,
          `Première victoire de ${name} sur ${sq} sur ce plateau (après ${h.matches} matchs)`
        ),
        tr(`That's the FIRST time ${name} has ever killed ${sq}!`, `C'est la PREMIÈRE fois que ${name} vient à bout de ${sq} !`)
      );
    } else if (MILESTONES.includes(career)) {
      say(
        "milestone",
        "🔢",
        "happy",
        tr(`${name}'s ${ordinal(career)} ${sq}`, `${name} : ${ordinal(career, true)} victoire sur ${sq}`),
        tr(`That's ${name}'s ${ordinal(career)} ${sq} kill (all time)!`, `C'est la ${ordinal(career, true)} victoire de ${name} sur ${sq} (au total) !`)
      );
    }

    // -- The clock: world record, personal best, near the record, off their usual, the field ----
    if (before === undefined || !before.auto || !auto) continue;
    const gap = seconds - before.seconds;
    if (gap < MIN_GAP_SECONDS) continue;

    const board = records[square];
    const wr = board?.holders[0];
    const rank = allTimeRank(board, gap);
    const fights = h.gaps.get(square) ?? [];
    const pb = fights.length > 0 ? Math.min(...fights) : null;
    const t = clock(gap);
    const took = tr(`${name}: ${sq} in ${t}`, `${name} : ${sq} en ${t}`);
    const kill = tr(`${name}'s kill of ${sq} in ${t}`, `${name} vient à bout de ${sq} en ${t}`);

    if (wr && gap < wr.seconds) {
      const own = wr.key === who.key;
      say(
        "wr",
        "🌍",
        "happy",
        own
          ? tr(`${took} - beats their own world record (${clock(wr.seconds)})`, `${took} - bat son propre record du monde (${clock(wr.seconds)})`)
          : tr(
              `${took} - under the world record (${clock(wr.seconds)}, ${wr.nickname})`,
              `${took} - sous le record du monde (${clock(wr.seconds)}, ${wr.nickname})`
            ),
        own
          ? tr(`NEW WORLD RECORD! ${name} just beat their OWN best on ${sq} - ${t}!`, `NOUVEAU RECORD DU MONDE ! ${name} bat son PROPRE record sur ${sq} - ${t} !`)
          : tr(
              `NEW WORLD RECORD! ${name} kills ${sq} in ${t} - beating ${wr.nickname}'s ${clock(wr.seconds)}!`,
              `NOUVEAU RECORD DU MONDE ! ${name} vient à bout de ${sq} en ${t} - et bat les ${clock(wr.seconds)} de ${wr.nickname} !`
            ),
        true
      );
    } else if (pb !== null && gap < pb) {
      say(
        "pb",
        "🏅",
        "happy",
        tr(`${took} - personal best (was ${clock(pb)})${rankTag(rank)}`, `${took} - record personnel (avant : ${clock(pb)})${rankTag(rank)}`),
        tr(
          `That's the fastest ${name} has ever killed ${sq}! ${t}${rankTag(rank)}!`,
          `Jamais ${name} n'avait vaincu ${sq} aussi vite ! ${t}${rankTag(rank)} !`
        ),
        true
      );
    } else if (wr && gap - wr.seconds <= Math.max(NEAR_RECORD.seconds, wr.seconds * NEAR_RECORD.share)) {
      const own = wr.key === who.key;
      const tie = gap === wr.seconds;
      const off = clock(gap - wr.seconds);
      say(
        "near-wr",
        "🌍",
        // Tying your own record is still a good night; missing someone else's by seconds is not.
        tie && own ? "smug" : "angry",
        tie
          ? own
            ? tr(`${took} - ties their own world record`, `${took} - égale son propre record du monde`)
            : tr(
                `${took} - ties the world record (${wr.nickname} keeps it, first to get there)`,
                `${took} - égale le record du monde (${wr.nickname} le garde, l'ayant établi en premier)`
              )
          : tr(
              `${took} - ${off} off the world record (${clock(wr.seconds)}, ${wr.nickname})`,
              `${took} - à ${off} du record du monde (${clock(wr.seconds)}, ${wr.nickname})`
            ),
        tie
          ? own
            ? tr(`${name} matches their OWN world record on ${sq} - ${t}!`, `${name} égale son PROPRE record du monde sur ${sq} - ${t} !`)
            : tr(
                `${name} TIES the world record on ${sq} - but ${wr.nickname} got there first!`,
                `${name} ÉGALE le record du monde sur ${sq} - mais ${wr.nickname} l'a établi en premier !`
              )
          : tr(
              `SO CLOSE! ${kill} - just ${off} off the world record${rankTag(rank)}!`,
              `SI PRÈS ! ${kill} - à seulement ${off} du record du monde${rankTag(rank)} !`
            )
      );
    } else if (fights.length >= USUAL_AFTER_FIGHTS && Math.abs(gap - median(fights)) >= Math.max(PACE_GAP.seconds, median(fights) * PACE_GAP.share)) {
      const usual = median(fights);
      const off = gap - usual;
      const by = clock(Math.abs(off));
      say(
        "pace",
        off < 0 ? "⚡" : "🐢",
        off < 0 ? "happy" : "grim",
        off < 0
          ? tr(`${took} - ${by} quicker than usual (${clock(usual)} over ${fights.length})`, `${took} - ${by} plus rapide que d'habitude (${clock(usual)} sur ${fights.length})`)
          : tr(`${took} - ${by} slower than usual (${clock(usual)} over ${fights.length})`, `${took} - ${by} plus lent que d'habitude (${clock(usual)} sur ${fights.length})`),
        off < 0
          ? tr(`${kill} - ${by} faster than usual${rankTag(rank)}!`, `${kill} - ${by} plus vite que d'habitude${rankTag(rank)} !`)
          : tr(`Uh oh! ${name} needed ${t} for ${sq} - ${by} slower than usual!`, `Aïe ! ${name} a mis ${t} sur ${sq} - ${by} de plus que d'habitude !`)
      );
    } else if (board && board.fights >= GLOBAL_AFTER_FIGHTS && gap < board.median) {
      // The field's typical time is the median, as everywhere a "usual" is read on this site.
      say(
        "field",
        "🚀",
        "happy",
        tr(
          `${took} - under the global average (${clock(board.median)} over ${board.fights})${rankTag(rank)}`,
          `${took} - sous la moyenne mondiale (${clock(board.median)} sur ${board.fights})${rankTag(rank)}`
        ),
        tr(`${kill} - faster than the global average!${rankTag(rank)}`, `${kill} - plus vite que la moyenne mondiale !${rankTag(rank)}`)
      );
    }
  }

  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
