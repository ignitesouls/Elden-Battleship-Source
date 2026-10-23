import type { ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { twitchUrl, type EventDetail, type MatchRow, type PlayerProfileBits, type TeamRow } from "../lib/tournament/api";
import { groupLabel } from "../lib/tournament/groupNames";
import { matchOrder, meetings, ordinal, teamRecord, type TeamRecord } from "../lib/tournament/record";
import { START, matchLine, moneyline, type PlayerPower } from "../lib/tournament/teamPower";
import { isSupabaseConfigured } from "../lib/supabase";
import { useAuthProfile } from "../hooks/useAuthProfile";
import { useEventData } from "../hooks/useEventData";
import type { TeamPowerInfo } from "../hooks/useTeamPowers";
import { useLanguage, useT, type Language } from "../lib/language";
import { LoadingScreen } from "../components/BrandMark";
import { EventLogo } from "../components/event/EventLogo";
import { PlayerName, TeamLabel, TeamLogo } from "../components/event/TeamLogo";
import { JustForFun } from "../components/event/PowerLine";
import { useMatchWhen } from "../components/event/MatchTimeField";
import { RecapLinks } from "../components/event/RecapLinks";
import "../components/Tournament.css";
import "./TaleOfTheTape.css";

/**
 * The tale of the tape: a crew measured up, or two crews measured against each other, the way a fight
 * card does it - each side's logo big in a porthole, then the numbers side by side down a centre line.
 *
 *   /event/:id/team/:teamId   one crew's card: its record, standing, power, results and crew
 *   /event/:id/vs/:a/:b       two crews face to face: the same numbers, compared row by row with the
 *                             better side picked out, the line, and every meeting between them so far
 *
 * Read entirely from what the event page already loads (useEventData) - no request of its own - so it
 * can never say something the standings or the bracket don't. Public, like the event page: anyone with
 * the link can look, and a caster can put it on screen before a match.
 */

type EventData = ReturnType<typeof useEventData>;

/** The event as the reader sees it - signed in, their own pending team would show (but the tape only shows approved ones). */
function useTapeEvent(id: string) {
  const profile = useAuthProfile();
  const userId = profile?.isTwitch ? profile.userId : null;
  return useEventData(id, userId);
}

function Shell({ data, children }: { data: EventData; children: (event: EventDetail) => ReactNode }) {
  const t = useT();
  const { event, error } = data;
  if (!isSupabaseConfigured) return <div className="panel">{t("Supabase isn't configured.", "Supabase n'est pas configuré.")}</div>;
  if (event === undefined && !error) return <LoadingScreen>{t("Unrolling the tape...", "On déroule le ruban...")}</LoadingScreen>;
  if (!event) {
    return (
      <Missing to="/" label={t("Back to the harbor", "Retour au port")}>
        {error ?? t("There's no event here - it may not have opened yet.", "Il n'y a pas d'événement ici - il n'est peut-être pas encore ouvert.")}
      </Missing>
    );
  }
  return (
    <div className="stack tape" style={{ width: "min(820px, 100%)" }}>
      <div className="tape-event">
        <EventLogo path={event.logo_path} size={2.2} />
        <Link to={`/event/${event.id}`}>{event.name}</Link>
      </div>
      {children(event)}
    </div>
  );
}

function Missing({ to, label, children }: { to: string; label: string; children: ReactNode }) {
  return (
    <div className="panel stack" style={{ width: "min(560px, 100%)", alignItems: "center", textAlign: "center" }}>
      <p className="muted" style={{ margin: 0 }}>{children}</p>
      <Link to={to}>{label}</Link>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
//  The numbers
// ---------------------------------------------------------------------------------------------------

/** Everything the tape says about one crew, worked out once. */
interface Measure {
  team: TeamRow;
  record: TeamRecord;
  /** Its row in its qualifier table, and which table - for "3rd in Group B". */
  standing: { rank: number; of: number; table: number } | null;
  power: TeamPowerInfo | undefined;
  /** Average Elo across the crew, an unknown player counting as an average one (as the power does). */
  elo: number | null;
  /** Average battle rating of those who have one. */
  battle: number | null;
  /** Counted games behind the crew's numbers, all players together. */
  games: number | null;
}

function measure(team: TeamRow, data: EventData): Measure {
  const record = teamRecord(data.matches, team.id);
  const table = data.standings?.tables.findIndex((rows) => rows.some((r) => r.id === team.id)) ?? -1;
  const row = table >= 0 ? data.standings!.tables[table].find((r) => r.id === team.id) : undefined;
  const power = data.powers?.get(team.id);
  const players = power?.players ?? [];
  const battles = players.map((p) => p?.battle).filter((b): b is number => b !== null && b !== undefined);
  return {
    team,
    record,
    standing: row ? { rank: row.rank, of: data.standings!.tables[table].length, table } : null,
    power,
    elo: power && players.length > 0 ? players.reduce((s, p) => s + (p?.elo ?? START), 0) / players.length : null,
    battle: battles.length > 0 ? battles.reduce((s, b) => s + b, 0) / battles.length : null,
    games: power ? players.reduce((s, p) => s + (p?.games ?? 0), 0) : null,
  };
}

/** One row of the tape: what it is, each side's figure, and which way is better (or neither). */
interface TapeRow {
  label: string;
  hint?: string;
  a: ReactNode;
  b?: ReactNode;
  /** The numbers to compare: higher wins unless `lower`. Null on either side, or equal, picks no one. */
  score?: [number | null, number | null];
  lower?: boolean;
  /** Figures that come from team power, and so carry the asterisk. */
  forFun?: boolean;
}

function edge(row: TapeRow): "a" | "b" | null {
  if (!row.score) return null;
  const [x, y] = row.score;
  if (x === null || y === null || x === y) return null;
  return (row.lower ? x < y : x > y) ? "a" : "b";
}

/** The crews' own rows of the tape - one crew, or two side by side. */
function tapeRows(event: EventDetail, grouped: boolean, x: Measure, y: Measure | null, t: (en: string, fr: string) => string, lang: Language): TapeRow[] {
  const dash = "—";
  const list = (pick: (m: Measure) => ReactNode) => ({ a: pick(x), b: y ? pick(y) : undefined });
  const pair = (pick: (m: Measure) => number | null): [number | null, number | null] => [pick(x), y ? pick(y) : null];
  const where = (m: Measure) => (m.standing && grouped ? groupLabel(event.group_names, m.standing.table, lang) : t("the table", "le classement"));
  // Two crews in different groups both "1st" is no contest - a standing is only compared within a table.
  const sameTable = !!y && !!x.standing && !!y.standing && x.standing.table === y.standing.table;

  const rows: TapeRow[] = [
    {
      label: t("Power", "Puissance"),
      hint: t("The average of the crew's players, from results and battle ratings. 1500 is an average side.", "La moyenne des joueurs de l'équipage, d'après résultats et notes de combat. 1500 = équipe moyenne."),
      ...list((m) => (m.power ? `${Math.round(m.power.power)}${m.power.rated === 0 ? "?" : ""}` : dash)),
      score: pair((m) => m.power?.power ?? null),
      forFun: true,
    },
    {
      label: t("Series", "Séries"),
      hint: t("Matches won and lost in this event. Byes not counted.", "Matchs gagnés et perdus dans cet événement. Exemptions non comptées."),
      ...list((m) => `${m.record.won} - ${m.record.lost}`),
      score: pair((m) => m.record.won - m.record.lost),
    },
    {
      label: t("Games", "Manches"),
      hint: t("Games won and lost inside those matches. Forfeits add none.", "Manches gagnées et perdues dans ces matchs. Les forfaits n'en ajoutent pas."),
      ...list((m) => `${m.record.gamesWon} - ${m.record.gamesLost}`),
      score: pair((m) => m.record.gamesWon - m.record.gamesLost),
    },
  ];
  if (x.standing || y?.standing) {
    rows.push({
      label: t("Standing", "Rang"),
      ...list((m) => (m.standing ? <>{ordinal(m.standing.rank, lang)}<small>{t(`of ${m.standing.of} in ${where(m)}`, `sur ${m.standing.of} dans ${where(m)}`)}</small></> : dash)),
      score: sameTable ? pair((m) => m.standing?.rank ?? null) : undefined,
      lower: true,
    });
  }
  if (x.team.seed !== null || y?.team.seed != null) {
    rows.push({
      label: t("Seed", "Tête de série"),
      ...list((m) => (m.team.seed !== null ? `#${m.team.seed}` : dash)),
      score: pair((m) => m.team.seed),
      lower: true,
    });
  }
  rows.push(
    {
      label: t("Elo", "Elo"),
      hint: t("The crew's average Elo from every counted game on the site. Unknown players count as 1500.", "L'Elo moyen de l'équipage sur toutes les parties comptées du site. Un joueur inconnu compte 1500."),
      ...list((m) => (m.elo !== null ? String(Math.round(m.elo)) : dash)),
      score: pair((m) => m.elo),
      forFun: true,
    },
    {
      label: t("Battle rating", "Note de combat"),
      hint: t("The Hall of Fame rating (0-100), averaged over the players who have one.", "La note du Panthéon (0-100), moyenne des joueurs qui en ont une."),
      ...list((m) => (m.battle !== null ? m.battle.toFixed(1) : dash)),
      score: pair((m) => m.battle),
      forFun: true,
    },
    {
      label: t("Sea time", "Temps en mer"),
      hint: t("Counted games the whole crew has played on the site, all together.", "Parties comptées jouées sur le site par tout l'équipage, au total."),
      ...list((m) => (m.games !== null ? t(`${m.games} games`, `${m.games} parties`) : dash)),
      score: pair((m) => m.games),
    },
  );
  return rows;
}

/** The tape itself: label down the middle, each side's figure either side of it, the better one in brass. */
function Tape({ rows, single = false }: { rows: TapeRow[]; single?: boolean }) {
  return (
    <div className={`tape-rows${single ? " tape-rows--single" : ""}`}>
      {rows.map((row) => {
        const won = edge(row);
        const label = (
          <span className="tape-rows__label" title={row.hint}>
            {row.label}
            {row.forFun && "*"}
          </span>
        );
        return single ? (
          <div className="tape-rows__row" key={row.label}>
            {label}
            <span className="tape-rows__value">{row.a}</span>
          </div>
        ) : (
          <div className="tape-rows__row" key={row.label}>
            <span className={`tape-rows__value tape-rows__value--a${won === "a" ? " is-edge" : ""}`}>{row.a}</span>
            {label}
            <span className={`tape-rows__value tape-rows__value--b${won === "b" ? " is-edge" : ""}`}>{row.b}</span>
          </div>
        );
      })}
    </div>
  );
}

/** A crew's logo, big, behind brass - and its name under it. */
/**
 * `twitch` is the entrant's login in an individual event: the name then opens their channel, and the
 * porthole (their avatar) takes over `to`.
 */
function Porthole({ team, logo, to, twitch, children }: { team: TeamRow; logo: string | undefined; to?: string; twitch?: string; children?: ReactNode }) {
  const t = useT();
  const name = <span className="tape-side__name">{team.name}</span>;
  const live = !!twitchUrl(twitch);
  return (
    <div className="tape-side">
      {to && live ? (
        <Link to={to} className="tape-porthole">
          <TeamLogo url={logo} size="fill" />
        </Link>
      ) : (
        <div className="tape-porthole">
          <TeamLogo url={logo} size="fill" />
        </div>
      )}
      {live ? <PlayerName name={name} login={twitch} /> : to ? <Link to={to}>{name}</Link> : name}
      {team.forfeited_at && <span className="badge badge--bad">{t("withdrawn", "retirée")}</span>}
      {children}
    </div>
  );
}

function Kicker({ children }: { children: ReactNode }) {
  return (
    <div className="tape-kicker">
      <span className="tape-kicker__rope" aria-hidden />
      <h1>{children}</h1>
      <span className="tape-kicker__rope" aria-hidden />
    </div>
  );
}

function useStageLabel(event: EventDetail) {
  const t = useT();
  const lang = useLanguage();
  return (m: MatchRow) =>
    `${m.stage === "group" ? (m.grp !== null ? groupLabel(event.group_names, m.grp, lang) : t("Groups", "Poules")) : m.stage === "swiss" ? t("Swiss", "Suisse") : t("Knockout", "Élimination")} · ${t("Round", "Tour")} ${m.phase ?? m.round}`;
}

// ---------------------------------------------------------------------------------------------------
//  The crew
// ---------------------------------------------------------------------------------------------------

function Crew({ team, power, profiles }: { team: TeamRow; power: TeamPowerInfo | undefined; profiles: Map<string, PlayerProfileBits> }) {
  const t = useT();
  return (
    <div className="tape-crew">
      {team.roster.map((m, i) => (
        <CrewCard key={m.user_id} member={m} reading={power?.players[i]} avatar={profiles.get(m.user_id)?.avatar_url ?? null} twitch={profiles.get(m.user_id)?.twitch_login ?? null} />
      ))}
      {team.roster.length === 0 && <span className="muted">{t("No one on the roster.", "Personne dans l'équipage.")}</span>}
    </div>
  );
}

/** One player: the avatar opens their career, the name their Twitch (plain text if they have none). */
function CrewCard({ member, reading, avatar, twitch }: { member: TeamRow["roster"][number]; reading: PlayerPower | undefined; avatar: string | null; twitch: string | null }) {
  const t = useT();
  const known = !!reading && (reading.games > 0 || reading.battle !== null);
  return (
    <div className="tape-mate">
      <Link to={`/player/${encodeURIComponent(member.user_id)}`} className="tape-mate__career" title={t("Career", "Carrière")} aria-label={t(`${member.display_name}'s career`, `Carrière de ${member.display_name}`)}>
        <TeamLogo url={avatar} size={2.6} />
      </Link>
      <span className="tape-mate__who">
        <strong><PlayerName name={member.display_name} login={twitch} /></strong>
        {member.is_captain && <span className="tape-mate__captain">{t("captain", "capitaine")}</span>}
      </span>
      <span className="tape-mate__numbers">
        {known ? (
          <>
            <span title={t("Elo", "Elo")}>{Math.round(reading!.elo)}</span>
            <span title={t("Battle rating", "Note de combat")}>{reading!.battle !== null ? reading!.battle.toFixed(0) : "—"}</span>
            <small>{t(`${reading!.games} games`, `${reading!.games} parties`)}</small>
          </>
        ) : (
          <small>{t("new to these waters", "nouveau dans ces eaux")}</small>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
//  /event/:id/team/:teamId
// ---------------------------------------------------------------------------------------------------

export function TeamTape() {
  const { id = "", teamId = "" } = useParams();
  const data = useTapeEvent(id);
  return <Shell data={data}>{(event) => <TeamTapeBody event={event} teamId={teamId} data={data} />}</Shell>;
}

function TeamTapeBody({ event, teamId, data }: { event: EventDetail; teamId: string; data: EventData }) {
  const t = useT();
  const lang = useLanguage();
  const navigate = useNavigate();
  const stage = useStageLabel(event);
  const when = useMatchWhen();
  const team = data.teams.find((x) => x.id === teamId && x.status === "approved");
  const m = team ? measure(team, data) : null;
  if (!team || !m) {
    return <Missing to={`/event/${event.id}`} label={t("Back to the event", "Retour à l'événement")}>{t("That crew isn't in this event.", "Cet équipage ne fait pas partie de cet événement.")}</Missing>;
  }

  const rows = tapeRows(event, !!data.standings?.grouped, m, null, t, lang);
  const others = data.teams.filter((x) => x.status === "approved" && x.id !== team.id).sort((a, b) => a.name.localeCompare(b.name));
  const ours = data.matches.filter((x) => x.entrant_a === team.id || x.entrant_b === team.id).sort(matchOrder);
  const vs = (other: string) => `/event/${event.id}/vs/${team.id}/${other}`;

  return (
    <>
      <Kicker>{t("Tale of the Tape", "Fiche du combat")}</Kicker>
      <div className="tape-faceoff tape-faceoff--single">
        <Porthole team={team} logo={data.logos.get(team.id)} twitch={data.twitch.get(team.id)}>
          <span className="muted tape-side__sub">
            {event.team_size === 1 ? t("Single-handed", "En solitaire") : t(`Crew of ${team.roster.length}`, `Équipage de ${team.roster.length}`)}
          </span>
        </Porthole>
      </div>

      <div className="panel tape-panel">
        <Tape rows={rows} single />
      </div>

      {others.length > 0 && (
        <div className="panel row tape-measure">
          <span>{t("Measure them against", "Les mesurer à")}</span>
          <select value="" onChange={(e) => e.target.value && navigate(vs(e.target.value))}>
            <option value="">{t("pick a crew...", "choisir un équipage...")}</option>
            {others.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
        </div>
      )}

      {ours.length > 0 && (
        <div className="panel stack">
          <h3 style={{ margin: 0 }}>{t("Voyages", "Traversées")}</h3>
          <div className="t-list">
            {ours.map((x) => {
              const theirs = x.entrant_a === team.id ? x.entrant_b : x.entrant_a;
              const them = theirs ? data.teams.find((y) => y.id === theirs) : undefined;
              const weAreA = x.entrant_a === team.id;
              const done = x.status === "done";
              const recaps = data.games.get(x.id);
              return (
                <div className="t-item" key={x.id}>
                  <span>
                    {done && them && <span className={x.winner === team.id ? "cq-result--won" : "cq-result--lost"}>{x.winner === team.id ? t("Won", "Victoire") : t("Lost", "Défaite")} </span>}
                    {done && !them && <span className="cq-result--won">{t("Bye", "Exempt")} </span>}
                    {them ? <>{t("vs", "contre")} <TeamLabel name={<PlayerName name={them.name} login={data.twitch.get(them.id)} />} logo={data.logos.get(them.id)} size={1.3} /></> : !done && <span className="muted">{t("opponent not decided yet", "adversaire pas encore connu")}</span>}
                    <span className="muted" style={{ fontSize: "0.78rem" }}> · {stage(x)}</span>
                  </span>
                  <span className="row" style={{ gap: "0.5rem", fontSize: "0.85rem" }}>
                    {done && them && x.result_kind !== "forfeit" && <strong className="t-score">{weAreA ? x.score_a : x.score_b} - {weAreA ? x.score_b : x.score_a}</strong>}
                    {x.result_kind === "forfeit" && done && <span className="badge">{t("forfeit", "forfait")}</span>}
                    {!done && x.agreed_at && <span className="badge badge--good">{when(x.agreed_at)}</span>}
                    <RecapLinks keys={recaps} />
                    {them && !(done && recaps?.length) && <Link to={vs(them.id)}>{t("Tale of the tape", "Fiche du combat")} ›</Link>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>{event.team_size === 1 ? t("The player", "Le joueur") : t("The crew", "L'équipage")}</h3>
        <Crew team={team} power={m.power} profiles={data.profiles} />
        <span className="muted" style={{ fontSize: "0.72rem" }}>{t("Elo · battle rating · counted games. A player's picture opens their career, their name their Twitch.", "Elo · note de combat · parties comptées. La photo d'un joueur ouvre sa carrière, son nom sa chaîne Twitch.")}</span>
      </div>

      <Footer event={event} data={data} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------
//  /event/:id/vs/:a/:b
// ---------------------------------------------------------------------------------------------------

export function MatchupTape() {
  const { id = "", a = "", b = "" } = useParams();
  const data = useTapeEvent(id);
  return <Shell data={data}>{(event) => <MatchupBody event={event} aId={a} bId={b} data={data} />}</Shell>;
}

/**
 * The same matchup, opened inside a match card on the front page. It reads the event only once someone
 * opens it, and stops when they close it. The card already shows the two teams and the time, so this
 * leaves out the title, the portholes and the next-match line.
 */
export function MatchupTapeInline({ eventId, a, b }: { eventId: string; a: string; b: string }) {
  const t = useT();
  const data = useTapeEvent(eventId);
  if (!data.event) {
    return (
      <p className="muted" style={{ margin: 0, textAlign: "center", fontSize: "0.85rem" }}>
        {data.event === undefined && !data.error ? t("Unrolling the tape...", "On déroule le ruban...") : data.error ?? t("This event can't be found.", "Événement introuvable.")}
      </p>
    );
  }
  return (
    <div className="stack tape">
      <MatchupBody event={data.event} aId={a} bId={b} data={data} embedded />
    </div>
  );
}

function MatchupBody({ event, aId, bId, data, embedded = false }: { event: EventDetail; aId: string; bId: string; data: EventData; embedded?: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const stage = useStageLabel(event);
  const when = useMatchWhen();
  const find = (id: string) => data.teams.find((x) => x.id === id && x.status === "approved");
  const teamA = find(aId);
  const teamB = find(bId);
  if (!teamA || !teamB || aId === bId) {
    return <Missing to={`/event/${event.id}`} label={t("Back to the event", "Retour à l'événement")}>{t("One of those crews isn't in this event.", "L'un de ces équipages ne fait pas partie de cet événement.")}</Missing>;
  }
  const x = measure(teamA, data);
  const y = measure(teamB, data);
  const rows = tapeRows(event, !!data.standings?.grouped, x, y, t, lang);

  const met = meetings(data.matches, teamA.id, teamB.id);
  const upcoming = met.find((m) => m.status === "ready" || m.status === "in_progress" || m.status === "pending");
  // The line is for the meeting still to come; without one, a single game.
  const bestOf = upcoming?.best_of ?? 1;
  const line = x.power && y.power && (x.power.rated > 0 || y.power.rated > 0) ? matchLine(x.power.power, y.power.power, bestOf) : null;
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  const scoreFor = (m: MatchRow, team: string) => (m.entrant_a === team ? m.score_a : m.score_b);
  const played = met.filter((m) => m.status === "done");
  const winsA = met.filter((m) => m.status === "done" && m.winner === teamA.id).length;
  const winsB = met.filter((m) => m.status === "done" && m.winner === teamB.id).length;

  const lineRows: TapeRow[] = line
    ? [
        {
          label: bestOf > 1 ? t(`Win chance (best of ${bestOf})`, `Chances (au meilleur de ${bestOf})`) : t("Win chance", "Chances de victoire"),
          a: pct(line.pA),
          b: pct(1 - line.pA),
          score: [line.pA, 1 - line.pA],
          forFun: true,
        },
        { label: t("Moneyline", "Cote"), a: line.a, b: line.b, forFun: true },
        ...(line.handicap
          ? [
              {
                label: t("Handicap", "Handicap"),
                a: line.handicap.favourite === "a" ? `-${line.handicap.games} (${moneyline(line.handicap.cover)})` : `+${line.handicap.games}`,
                b: line.handicap.favourite === "b" ? `-${line.handicap.games} (${moneyline(line.handicap.cover)})` : `+${line.handicap.games}`,
                forFun: true,
              },
            ]
          : []),
      ]
    : [];
  if (played.length > 0) {
    lineRows.push({ label: t("Head to head", "Face à face"), hint: t("Matches between these two in this event.", "Matchs entre ces deux dans cet événement."), a: String(winsA), b: String(winsB), score: [winsA, winsB] });
  }

  return (
    <>
      {!embedded && (
        <>
          <Kicker>{t("Tale of the Tape", "Fiche du combat")}</Kicker>
          <div className="tape-faceoff">
            <Porthole team={teamA} logo={data.logos.get(teamA.id)} twitch={data.twitch.get(teamA.id)} to={`/event/${event.id}/team/${teamA.id}`} />
            <div className="tape-vs" aria-label={t("versus", "contre")}>
              <span>{t("VS", "VS")}</span>
            </div>
            <Porthole team={teamB} logo={data.logos.get(teamB.id)} twitch={data.twitch.get(teamB.id)} to={`/event/${event.id}/team/${teamB.id}`} />
          </div>

          {upcoming && (
            <div className="tape-next">
              {stage(upcoming)}
              {upcoming.best_of > 1 && ` · ${t(`best of ${upcoming.best_of}`, `au meilleur de ${upcoming.best_of}`)}`}
              {upcoming.status === "in_progress" && <> · <span className="badge badge--warn">{t("under way", "en cours")} {scoreFor(upcoming, teamA.id)} - {scoreFor(upcoming, teamB.id)}</span></>}
              {upcoming.status !== "in_progress" && upcoming.agreed_at && <> · <strong>{when(upcoming.agreed_at)}</strong></>}
            </div>
          )}
        </>
      )}

      <div className="panel tape-panel">
        <Tape rows={[...lineRows, ...rows]} />
      </div>

      {played.length > 0 && (
        <div className="panel stack">
          <h3 style={{ margin: 0 }}>{t("Previous engagements", "Engagements précédents")}</h3>
          <div className="t-list">
            {played.map((m) => {
              const winner = m.winner === teamA.id ? teamA : m.winner === teamB.id ? teamB : null;
              return (
                <div className="t-item" key={m.id}>
                  <span>
                    {winner ? <TeamLabel name={<strong><PlayerName name={winner.name} login={data.twitch.get(winner.id)} /></strong>} logo={data.logos.get(winner.id)} size={1.3} /> : t("Draw", "Nul")}
                    <span className="muted" style={{ fontSize: "0.78rem" }}> · {stage(m)}</span>
                  </span>
                  {m.result_kind === "forfeit" ? <span className="badge">{t("forfeit", "forfait")}</span> : <strong className="t-score">{scoreFor(m, teamA.id)} - {scoreFor(m, teamB.id)}</strong>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="tape-crews">
        {[teamA, teamB].map((team) => (
          <div className="panel stack" key={team.id}>
            <h3 style={{ margin: 0 }}>
              <TeamLabel name={<PlayerName name={team.name} login={data.twitch.get(team.id)} />} logo={data.logos.get(team.id)} size={1.6} />
            </h3>
            <Crew team={team} power={data.powers?.get(team.id)} profiles={data.profiles} />
          </div>
        ))}
      </div>

      {embedded ? (
        <div style={{ textAlign: "center", fontSize: "0.85rem" }}>
          <Link to={`/event/${event.id}/vs/${teamA.id}/${teamB.id}`}>{t("Open as a full page", "Ouvrir en pleine page")}</Link>
          {data.powers && data.powers.size > 0 && <JustForFun />}
        </div>
      ) : (
        <>
          <div className="row" style={{ justifyContent: "center", gap: "0.8rem", fontSize: "0.85rem" }}>
            <Link to={`/event/${event.id}/vs/${teamB.id}/${teamA.id}`}>{t("Swap sides", "Inverser les côtés")}</Link>
          </div>
          <Footer event={event} data={data} />
        </>
      )}
    </>
  );
}

function Footer({ event, data }: { event: EventDetail; data: EventData }) {
  const t = useT();
  return (
    <div style={{ textAlign: "center" }}>
      <Link to={`/event/${event.id}`}>{t("Back to the event", "Retour à l'événement")}</Link>
      {data.powers && data.powers.size > 0 && <JustForFun />}
    </div>
  );
}
