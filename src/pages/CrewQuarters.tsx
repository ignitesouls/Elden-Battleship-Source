import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  fetchEntryCode,
  fetchOfficialLeaderboard,
  multitwitchUrl,
  type EventDetail,
  type MatchRow,
  type PlayerProfileBits,
  type TeamRow,
} from "../lib/tournament/api";
import { groupLabel } from "../lib/tournament/groupNames";
import { ordinal, teamRecord } from "../lib/tournament/record";
import { watchUrl } from "../lib/watchStream";
import { isSupabaseConfigured } from "../lib/supabase";
import { useAuthProfile } from "../hooks/useAuthProfile";
import { useEventData } from "../hooks/useEventData";
import type { TeamPowerInfo } from "../hooks/useTeamPowers";
import { useLanguage, useT } from "../lib/language";
import { LoadingScreen } from "../components/BrandMark";
import { EventLogo } from "../components/event/EventLogo";
import { PlayerName, TeamLabel } from "../components/event/TeamLogo";
import { JustForFun, MatchOdds, PowerTag } from "../components/event/PowerLine";
import { StandingsTable } from "../components/event/StandingsTable";
import { BracketView } from "../components/event/BracketView";
import { EventRulebook } from "../components/event/EventRulebook";
import { MatchTimeField, agreedByLabel, useMatchWhen } from "../components/event/MatchTimeField";
import { PlayerSceneSetup } from "../components/PlayerSceneSetup";
import { OverlayTokenBox, OverlayTokenError, OverlayTokenStart, useMyOverlayToken } from "../components/OverlayToken";
import { WatchLinkBox } from "../components/WatchLinkBox";
import "../components/Tournament.css";
import "./CrewQuarters.css";

type Tab = "orders" | "charts" | "log" | "signals" | "articles";
const TABS: Tab[] = ["orders", "charts", "log", "signals", "articles"];

/**
 * Crew Quarters: one team's own page in one event, for the players on it.
 *
 * Everything a crew needs between matches, in one place they can bookmark:
 *   Sailing Orders   every match of theirs still to play - who, by when, the time their captain has
 *                    confirmed (and, for the captain, the control that confirms it), the entry code,
 *                    and the links to hand out: Multitwitch, their own watch link, a Discord post
 *   The Charts       their group or Swiss table with their row picked out, then the bracket
 *   Ship's Log       their record, results, power and roster
 *   Signal Flags     the player OBS scene and the watch link - the player half of the OBS page and
 *                    nothing else (no caster layout, no auto-marking)
 *   Ship's Articles  the event's rules, the same component the public rules page renders
 *
 * Scheduling itself happens in Discord; this page is where the result of it is written down. Every
 * piece is shared with the page it came from (MatchTimeField, StandingsTable, EventRulebook,
 * PlayerSceneSetup, WatchLinkBox, useEventData), so nothing here can drift from what the rest of the
 * site says.
 *
 * Only for players on an approved team. Anyone else is pointed back at the event page; the database
 * refuses anything a captain-only control would send on their behalf anyway.
 */
export function CrewQuarters() {
  const { id = "" } = useParams();
  const t = useT();
  const profile = useAuthProfile();
  const userId = profile?.isTwitch ? profile.userId : null;
  const [params, setParams] = useSearchParams();
  const asked = params.get("tab") as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) ? asked : "orders";

  const data = useEventData(id, userId, { alwaysConfig: true });
  const { event, teams, error } = data;

  if (!isSupabaseConfigured) {
    return <div className="panel">{t("Supabase isn't configured.", "Supabase n'est pas configuré.")}</div>;
  }
  if (event === undefined && !error) return <LoadingScreen>{t("Opening your quarters...", "Ouverture de vos quartiers...")}</LoadingScreen>;

  const back = (to: string, label: string, message: string) => (
    <div className="panel stack" style={{ width: "min(560px, 100%)", alignItems: "center", textAlign: "center" }}>
      <p className="muted" style={{ margin: 0 }}>{message}</p>
      <Link to={to}>{label}</Link>
    </div>
  );

  if (!event) {
    if (error) return back("/", t("Back to the harbor", "Retour au port"), error);
    return back("/", t("Back to the harbor", "Retour au port"), t("There's no event here - it may not have opened yet.", "Il n'y a pas d'événement ici - il n'est peut-être pas encore ouvert."));
  }
  const toEvent = t("Back to the event", "Retour à l'événement");
  if (!userId) {
    return back(`/event/${event.id}`, toEvent, t("Sign in with Twitch to reach your crew's quarters.", "Connectez-vous avec Twitch pour accéder aux quartiers de votre équipage."));
  }
  const mine = teams.find((team) => team.status === "approved" && team.roster.some((m) => m.user_id === userId));
  if (!mine) {
    return back(
      `/event/${event.id}`,
      toEvent,
      t(
        "Crew Quarters are for players on an approved team in this event. If your team is still waiting for approval, check back once an administrator has approved it.",
        "Les quartiers de l'équipage sont réservés aux joueurs d'une équipe approuvée dans cet événement. Si votre équipe attend encore son approbation, revenez une fois qu'un administrateur l'aura approuvée.",
      ),
    );
  }

  const isCaptain = mine.captain_user_id === userId;
  const select = (next: Tab) => setParams(next === "orders" ? {} : { tab: next }, { replace: true });
  const tabs: Array<{ id: Tab; name: string; caption: string }> = [
    { id: "orders", name: t("Sailing Orders", "Ordres de route"), caption: t("matches & times", "matchs et horaires") },
    { id: "charts", name: t("The Charts", "Les cartes"), caption: t("standings", "classement") },
    { id: "log", name: t("Ship's Log", "Journal de bord"), caption: t("team stats", "stats de l'équipe") },
    { id: "signals", name: t("Signal Flags", "Pavillons"), caption: t("OBS & watch link", "OBS et lien de visionnage") },
    { id: "articles", name: t("Ship's Articles", "Charte du bord"), caption: t("the rules", "le règlement") },
  ];

  return (
    <div className="stack" style={{ width: "min(760px, 100%)" }}>
      <div className="cq-head">
        <EventLogo path={event.logo_path} size={4} />
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          <Link to={`/event/${event.id}`}>{event.name}</Link>
        </span>
        <h1>{t("Crew Quarters", "Quartiers de l'équipage")}</h1>
        <div className="row" style={{ justifyContent: "center", gap: "0.5rem" }}>
          <strong style={{ fontSize: "1.1rem" }}>
            <TeamLabel name={<PlayerName name={mine.name} login={data.twitch.get(mine.id)} />} logo={data.logos.get(mine.id)} size={2} />
          </strong>
          <span className="badge">{isCaptain ? t("captain", "capitaine") : t("crew", "équipage")}</span>
          {event.status === "finished" && <span className="badge badge--good">{t("event finished", "événement terminé")}</span>}
        </div>
      </div>

      {mine.forfeited_at && (
        <div className="panel" style={{ borderColor: "var(--danger)" }}>
          {t(
            "Your team has been withdrawn from this event by an administrator. Any matches left are recorded as forfeits.",
            "Votre équipe a été retirée de cet événement par un administrateur. Les matchs restants sont comptés comme forfaits.",
          )}
        </div>
      )}
      {event.status === "cancelled" && (
        <div className="panel stack" style={{ borderColor: "var(--danger)" }}>
          <strong>{t("This event was cancelled.", "Cet événement a été annulé.")}</strong>
          {event.cancel_reason && <span>{event.cancel_reason}</span>}
        </div>
      )}

      <div className="cq-tabs" role="tablist">
        {tabs.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? "on" : undefined} onClick={() => select(x.id)}>
            <strong>{x.name}</strong>
            <small>{x.caption}</small>
          </button>
        ))}
      </div>

      {error && <div className="error-text">{error}</div>}

      {tab === "orders" && <SailingOrders event={event} mine={mine} userId={userId} isCaptain={isCaptain} data={data} />}
      {tab === "charts" && <Charts event={event} mine={mine} data={data} />}
      {tab === "log" && <ShipsLog event={event} mine={mine} data={data} />}
      {tab === "signals" && <SignalFlags />}
      {tab === "articles" && (
        <>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Link to={`/event/${event.id}/rules`} className="muted" style={{ fontSize: "0.8rem" }}>
              {t("Open on its own page (for sharing)", "Ouvrir sur sa propre page (pour partager)")}
            </Link>
          </div>
          <EventRulebook event={event} config={data.config} />
        </>
      )}

      <div style={{ textAlign: "center" }}>
        <Link to={`/event/${event.id}`}>{toEvent}</Link>
        {(tab === "orders" || tab === "log") && data.powers && data.powers.size > 0 && <JustForFun />}
      </div>
    </div>
  );
}

type EventData = ReturnType<typeof useEventData>;

// ---------------------------------------------------------------------------------------------------
//  Shared bits
// ---------------------------------------------------------------------------------------------------

const order = (a: MatchRow, b: MatchRow) => (a.phase ?? a.round) - (b.phase ?? b.round) || a.idx - b.idx;

function useStageLabel(event: EventDetail) {
  const t = useT();
  const lang = useLanguage();
  return (m: MatchRow) =>
    m.stage === "group"
      ? m.grp !== null
        ? groupLabel(event.group_names, m.grp, lang)
        : t("Groups", "Poules")
      : m.stage === "swiss"
        ? t("Swiss", "Suisse")
        : t("Knockout", "Élimination");
}

function opponentOf(m: MatchRow, mine: TeamRow, teams: TeamRow[]): TeamRow | undefined {
  const theirs = m.entrant_a === mine.id ? m.entrant_b : m.entrant_a;
  return theirs ? teams.find((team) => team.id === theirs) : undefined;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      style={{ fontSize: "0.8rem" }}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? t("Copied!", "Copié !") : label}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------
//  Sailing Orders - matches & times
// ---------------------------------------------------------------------------------------------------

function SailingOrders({ event, mine, userId, isCaptain, data }: { event: EventDetail; mine: TeamRow; userId: string; isCaptain: boolean; data: EventData }) {
  const t = useT();
  const lang = useLanguage();
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    if (!isCaptain) return;
    let cancelled = false;
    fetchEntryCode(mine.id).then((c) => !cancelled && setCode(c)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mine.id, isCaptain]);

  if (event.status === "signup") {
    return (
      <div className="panel stack">
        <h3 style={{ margin: 0 }}>{t("Your matches", "Vos matchs")}</h3>
        <span className="muted">
          {event.starts_at
            ? t(
                `The event hasn't started yet - it's due to begin ${new Date(event.starts_at).toLocaleDateString(undefined, { month: "long", day: "numeric" })}. Your matches appear here as soon as the first round is drawn.`,
                `L'événement n'a pas encore commencé - début prévu le ${new Date(event.starts_at).toLocaleDateString("fr-FR", { month: "long", day: "numeric" })}. Vos matchs apparaîtront ici dès le tirage du premier tour.`,
              )
            : t("The event hasn't started yet. Your matches appear here as soon as the first round is drawn.", "L'événement n'a pas encore commencé. Vos matchs apparaîtront ici dès le tirage du premier tour.")}
        </span>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {t("Meanwhile: set up your stream under Signal Flags and read the rules under Ship's Articles.", "En attendant : configurez votre stream dans Pavillons et lisez le règlement dans Charte du bord.")}
        </span>
      </div>
    );
  }

  const ours = data.matches.filter((m) => m.entrant_a === mine.id || m.entrant_b === mine.id);
  const toPlay = ours.filter((m) => (m.status === "ready" || m.status === "in_progress") && opponentOf(m, mine, data.teams)).sort(order);
  const waiting = ours.filter((m) => m.status === "pending" || ((m.status === "ready" || m.status === "in_progress") && !opponentOf(m, mine, data.teams))).sort(order);
  const live = event.status === "live";

  return (
    <div className="stack">
      {live && isCaptain && code && (
        <div className="panel stack" style={{ gap: "0.3rem" }}>
          <span>
            <span className="muted" style={{ fontSize: "0.8rem" }}>{t("Your team's entry code", "Le code d'entrée de votre équipe")} </span>
            <span className="entry-code" style={{ fontSize: "1rem" }}>{code}</span>
          </span>
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            {t(
              "To play: one captain creates a room and picks \"Make this an official match\" in the lobby with their entry code; the other captain confirms with theirs. Keep the code off stream.",
              "Pour jouer : un capitaine crée une partie et choisit « Faire de ceci un match officiel » dans le salon avec son code d'entrée ; l'autre capitaine confirme avec le sien. Gardez le code hors du stream.",
            )}
          </span>
          <div>
            <Link to="/" className="link-button">{t("Create a room", "Créer une partie")}</Link>
          </div>
        </div>
      )}

      {toPlay.length === 0 && waiting.length === 0 && (
        <div className="panel">
          <span className="muted">
            {live
              ? t("Nothing waiting for you right now - the next round hasn't been drawn, or your run in this event is over.", "Rien ne vous attend pour l'instant - le tour suivant n'est pas encore tiré, ou votre parcours est terminé.")
              : t("No matches left to play. Your results are in the Ship's Log.", "Plus aucun match à jouer. Vos résultats sont dans le Journal de bord.")}
          </span>
        </div>
      )}

      {toPlay.map((m) => (
        <OrderCard key={m.id} event={event} match={m} mine={mine} userId={userId} isCaptain={isCaptain} data={data} />
      ))}

      {waiting.length > 0 && (
        <div className="panel stack">
          <h3 style={{ margin: 0 }}>{t("Further out", "Plus tard")}</h3>
          <div className="t-list">
            {waiting.map((m) => (
              <WaitingRow key={m.id} event={event} match={m} lang={lang} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WaitingRow({ event, match, lang }: { event: EventDetail; match: MatchRow; lang: string }) {
  const t = useT();
  const stage = useStageLabel(event);
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-FR" : undefined, { month: "short", day: "numeric" });
  return (
    <div className="t-item">
      <span>
        {stage(match)} · {t("Round", "Tour")} {match.phase ?? match.round}
        <span className="muted"> · {t("opponent not decided yet", "adversaire pas encore connu")}</span>
      </span>
      {match.due_at && <span className="muted" style={{ fontSize: "0.8rem" }}>{t("due by", "avant le")} {day(match.due_at)}</span>}
    </div>
  );
}

/**
 * One match to play: the line-up, the confirmed time, and the links to hand out once it is set.
 *
 * The Discord post uses Discord's own timestamp markup (<t:unix:F>), which every reader's Discord shows
 * in their own time zone - the same promise the site makes, carried into the place the event is run.
 */
function OrderCard({ event, match, mine, userId, isCaptain, data }: { event: EventDetail; match: MatchRow; mine: TeamRow; userId: string; isCaptain: boolean; data: EventData }) {
  const t = useT();
  const stage = useStageLabel(event);
  const them = opponentOf(match, mine, data.teams)!;
  const weAreA = match.entrant_a === mine.id;
  const logins = (team: TeamRow) => team.roster.map((m) => data.profiles.get(m.user_id)?.twitch_login);
  const streams = multitwitchUrl([...logins(mine), ...logins(them)]);
  const myLogin = data.profiles.get(userId)?.twitch_login;
  const base = `${window.location.origin}${window.location.pathname}`;
  const myWatch = myLogin ? watchUrl(base, myLogin) : null;
  const round = `${stage(match)} · ${t("Round", "Tour")} ${match.phase ?? match.round}`;
  const bestOf = match.best_of > 1 ? t(`best of ${match.best_of}`, `au meilleur de ${match.best_of}`) : null;

  const post = useMemo(() => {
    const lines = [`**${mine.name}** vs **${them.name}** · ${event.name} · ${round}${bestOf ? ` (${bestOf})` : ""}`];
    if (match.agreed_at) {
      const unix = Math.floor(new Date(match.agreed_at).getTime() / 1000);
      lines.push(`${t("When", "Quand")}: <t:${unix}:F> (<t:${unix}:R>)`);
    }
    if (streams) lines.push(`${t("Streams", "Streams")}: <${streams}>`);
    return lines.join("\n");
  }, [mine.name, them.name, event.name, round, bestOf, match.agreed_at, streams, t]);

  return (
    <div className="panel stack next-match">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <strong style={{ fontSize: "0.85rem" }}>{round}</strong>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {match.status === "in_progress" && <span className="badge badge--warn" style={{ marginRight: "0.4rem" }}>{t("under way", "en cours")}</span>}
          {bestOf}
        </span>
      </div>

      <div className="next-match__teams">
        <TeamLabel name={<strong><PlayerName name={mine.name} login={data.twitch.get(mine.id)} /></strong>} logo={data.logos.get(mine.id)} size={2.2} />
        <span className="muted">
          {match.status === "in_progress" ? `${weAreA ? match.score_a : match.score_b} - ${weAreA ? match.score_b : match.score_a}` : t("vs", "contre")}
        </span>
        <TeamLabel name={<strong><PlayerName name={them.name} login={data.twitch.get(them.id)} /></strong>} logo={data.logos.get(them.id)} size={2.2} />
      </div>

      {data.powers && (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <MatchOdds a={data.powers.get(mine.id)} b={data.powers.get(them.id)} nameA={mine.name} nameB={them.name} bestOf={match.best_of} />
        </div>
      )}
      <div style={{ textAlign: "center", fontSize: "0.85rem" }}>
        <Link to={`/event/${event.id}/vs/${mine.id}/${them.id}`}>{t("Tale of the tape", "Fiche du combat")} ›</Link>
      </div>

      {event.status === "live" && (
        <MatchTimeField match={match} isCaptain={isCaptain} setBy={agreedByLabel(match, userId, mine, them, t)} reload={data.reload} />
      )}

      <div className="stack" style={{ gap: "0.3rem" }}>
        <span className="muted" style={{ fontSize: "0.78rem" }}>
          {match.agreed_at
            ? t("Spread the word:", "Faites passer le mot :")
            : t("Once the time is confirmed, spread the word:", "Une fois l'heure confirmée, faites passer le mot :")}
        </span>
        <div className="cq-share">
          <CopyButton text={post} label={t("Copy post for Discord", "Copier le message pour Discord")} />
          {streams && (
            <a href={streams} target="_blank" rel="noreferrer" className="link-button" style={{ fontSize: "0.8rem" }}>
              {t("Multitwitch (both teams)", "Multitwitch (les deux équipes)")}
            </a>
          )}
          {myWatch && <CopyButton text={myWatch} label={t("Copy my watch link", "Copier mon lien de visionnage")} />}
        </div>
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          {t(
            "The Discord post shows the time in each reader's own time zone. Your watch link always opens the match you're in, from your seat - set it up under Signal Flags.",
            "Le message Discord affiche l'heure dans le fuseau horaire de chaque lecteur. Votre lien de visionnage ouvre toujours le match où vous êtes, depuis votre siège - configurez-le dans Pavillons.",
          )}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
//  The Charts - standings
// ---------------------------------------------------------------------------------------------------

function Charts({ event, mine, data }: { event: EventDetail; mine: TeamRow; data: EventData }) {
  const t = useT();
  const lang = useLanguage();
  const { standings, names, logos, twitch, departedIds, matches, powers } = data;
  const knockout = matches.filter((m) => m.stage === "knockout");

  if (!standings?.tables.length && knockout.length === 0) {
    return (
      <div className="panel">
        <span className="muted">{t("Standings appear here once the first round has been drawn.", "Le classement apparaîtra ici dès le tirage du premier tour.")}</span>
      </div>
    );
  }

  const ourTable = standings ? standings.tables.findIndex((rows) => rows.some((row) => row.id === mine.id)) : -1;
  const others = standings ? standings.tables.map((rows, g) => ({ rows, g })).filter(({ g }) => g !== ourTable) : [];
  const title = (g: number) => (standings?.grouped ? groupLabel(event.group_names, g, lang) : undefined);

  return (
    <div className="stack">
      {standings && ourTable >= 0 && (
        <div className="panel stack">
          <h3>{standings.grouped ? t("Your group", "Votre poule") : t("Standings", "Classement")}</h3>
          <StandingsTable
            rows={standings.tables[ourTable]}
            names={names}
            logos={logos}
            twitch={twitch}
            departed={departedIds}
            cut={standings.cuts?.[ourTable]}
            title={title(ourTable)}
            highlight={mine.id}
            eventId={event.id}
          />
          {standings.cuts !== undefined && (
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              {!standings.grouped
                ? t(`The top ${standings.cuts[0]} go through to the knockout - above the line.`, `Les ${standings.cuts[0]} premiers passent en élimination - au-dessus de la ligne.`)
                : standings.cuts.every((c) => c === standings.cuts![0])
                  ? t(`The top ${standings.cuts[0]} of each group go through to the knockout - above the line.`, `Les ${standings.cuts[0]} premiers de chaque poule passent en élimination - au-dessus de la ligne.`)
                  : t(`The top ${standings.cuts[ourTable]} of your group go through to the knockout - above the line.`, `Les ${standings.cuts[ourTable]} premiers de votre poule passent en élimination - au-dessus de la ligne.`)}{" "}
              {t("A dot after a rank means the teams are level on every tiebreak.", "Un point après un rang signifie une égalité sur tous les critères.")}
            </span>
          )}
        </div>
      )}

      {knockout.length > 0 && (
        <div className="panel stack">
          <h3>{t("Bracket", "Tableau")}</h3>
          <BracketView matches={knockout} names={names} logos={logos} twitch={twitch} powers={powers} eventId={event.id} />
        </div>
      )}

      {others.length > 0 && (
        <details className="panel">
          <summary style={{ cursor: "pointer" }}>{t(`The other groups (${others.length})`, `Les autres poules (${others.length})`)}</summary>
          <div className="stack" style={{ marginTop: "0.6rem" }}>
            {others.map(({ rows, g }) => (
              <StandingsTable key={g} rows={rows} names={names} logos={logos} twitch={twitch} departed={departedIds} cut={standings?.cuts?.[g]} title={title(g)} eventId={event.id} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
//  Ship's Log - team stats
// ---------------------------------------------------------------------------------------------------

function ShipsLog({ event, mine, data }: { event: EventDetail; mine: TeamRow; data: EventData }) {
  const t = useT();
  const lang = useLanguage();
  const stage = useStageLabel(event);
  const when = useMatchWhen();
  const { matches, teams, standings, powers, profiles } = data;
  const record = teamRecord(matches, mine.id);
  const results = matches.filter((m) => m.status === "done" && (m.entrant_a === mine.id || m.entrant_b === mine.id)).sort(order);

  const table = standings?.tables.findIndex((rows) => rows.some((row) => row.id === mine.id)) ?? -1;
  const row = table >= 0 ? standings!.tables[table].find((r) => r.id === mine.id) : undefined;
  const where = table >= 0 && standings?.grouped ? groupLabel(event.group_names, table, lang) : t("the table", "le classement");

  // Each player's official record across every event - one request for the whole board.
  const [official, setOfficial] = useState<Map<string, { played: number; wins: number }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchOfficialLeaderboard()
      .then((rows) => !cancelled && setOfficial(new Map(rows.map((r) => [r.player_key, { played: r.played, wins: r.wins }]))))
      .catch(() => !cancelled && setOfficial(new Map()));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="stack">
      <div className="panel stack">
        <h3 style={{ margin: 0 }}>{t("This event", "Cet événement")}</h3>
        <div className="cq-stats">
          <Stat label={t("Series", "Séries")} value={`${record.won} - ${record.lost}`} note={record.byes > 0 ? t(`plus ${record.byes} bye${record.byes === 1 ? "" : "s"}`, `plus ${record.byes} exempt(s)`) : t("won - lost", "gagnées - perdues")} />
          <Stat
            label={t("Games", "Manches")}
            value={`${record.gamesWon} - ${record.gamesLost}`}
            note={record.forfeits > 0 ? t(`${record.forfeits} forfeit${record.forfeits === 1 ? "" : "s"} not counted`, `${record.forfeits} forfait(s) non compté(s)`) : t("won - lost", "gagnées - perdues")}
          />
          {row && <Stat label={t("Standing", "Rang")} value={ordinal(row.rank, lang)} note={t(`of ${standings!.tables[table].length} in ${where}`, `sur ${standings!.tables[table].length} dans ${where}`)} />}
          {mine.seed !== null && <Stat label={t("Seed", "Tête de série")} value={`#${mine.seed}`} note={t("going in", "au départ")} />}
          {powers?.get(mine.id) && (
            <div className="cq-stat">
              <span>{t("Team power", "Puissance")}</span>
              <PowerTag info={powers.get(mine.id) as TeamPowerInfo} />
            </div>
          )}
        </div>
      </div>

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>{t("Results", "Résultats")}</h3>
        {results.length === 0 ? (
          <span className="muted">{t("No results yet.", "Pas encore de résultats.")}</span>
        ) : (
          <div className="t-list">
            {results.map((m) => {
              const them = opponentOf(m, mine, teams);
              const weAreA = m.entrant_a === mine.id;
              const won = m.winner === mine.id;
              return (
                <div className="t-item" key={m.id}>
                  <span>
                    <span className={won ? "cq-result--won" : "cq-result--lost"}>{won ? t("Won", "Victoire") : t("Lost", "Défaite")}</span>{" "}
                    {them ? (
                      <>
                        {t("vs", "contre")} <TeamLabel name={<PlayerName name={them.name} login={data.twitch.get(them.id)} />} logo={data.logos.get(them.id)} size={1.3} />
                      </>
                    ) : (
                      <span className="muted">{t("bye", "exempt")}</span>
                    )}
                    <span className="muted" style={{ fontSize: "0.78rem" }}> · {stage(m)} · {t("Round", "Tour")} {m.phase ?? m.round}</span>
                  </span>
                  <span className="muted row" style={{ fontSize: "0.85rem", gap: "0.4rem" }}>
                    {them && m.result_kind !== "forfeit" && <strong className="t-score">{weAreA ? m.score_a : m.score_b} - {weAreA ? m.score_b : m.score_a}</strong>}
                    {m.result_kind === "forfeit" && <span className="badge">{t("forfeit", "forfait")}</span>}
                    {m.result_kind === "admin" && <span className="badge" title={t("Entered by an administrator", "Saisi par un administrateur")}>{t("admin", "admin")}</span>}
                    {m.agreed_at && <span style={{ fontSize: "0.75rem" }}>{when(m.agreed_at)}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>{t("The crew", "L'équipage")}</h3>
        <div className="t-list">
          {mine.roster.map((m) => (
            <CrewRow key={m.user_id} member={m} bits={profiles.get(m.user_id)} official={official?.get(m.user_id)} loaded={official !== null} />
          ))}
        </div>
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          {t("Official record counts every official match in every event. Careers have the full numbers.", "Le bilan officiel compte chaque match officiel de chaque événement. Les carrières ont tous les chiffres.")}
        </span>
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="cq-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function CrewRow({
  member,
  bits,
  official,
  loaded,
}: {
  member: TeamRow["roster"][number];
  bits: PlayerProfileBits | undefined;
  official: { played: number; wins: number } | undefined;
  loaded: boolean;
}) {
  const t = useT();
  return (
    <div className="t-item">
      <span>
        <strong><PlayerName name={member.display_name} login={bits?.twitch_login} /></strong>
        {member.is_captain && <span className="badge" style={{ marginLeft: "0.4rem" }}>{t("captain", "capitaine")}</span>}
        {loaded && (
          <span className="muted" style={{ fontSize: "0.8rem", marginLeft: "0.5rem" }}>
            {official
              ? t(`official ${official.wins} - ${official.played - official.wins}`, `officiel ${official.wins} - ${official.played - official.wins}`)
              : t("no official matches yet", "aucun match officiel")}
          </span>
        )}
      </span>
      <span className="row" style={{ gap: "0.6rem", fontSize: "0.8rem" }}>
        {/* The name itself opens their Twitch. */}
        <Link to={`/player/${encodeURIComponent(member.user_id)}`}>{t("Career", "Carrière")}</Link>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
//  Signal Flags - the player's OBS scene and watch link
// ---------------------------------------------------------------------------------------------------

/**
 * The player half of the OBS page, and only that: the framed player scene (PlayerSceneSetup, the very
 * component the OBS page shows a player), the token it is built on, and the watch link. The caster's
 * layout, the loose elements and auto-marking stay on the OBS page, one link away.
 */
function SignalFlags() {
  const t = useT();
  const mine = useMyOverlayToken();
  const base = `${window.location.origin}${window.location.pathname}`;

  return (
    <div className="stack obs-page" style={{ gap: "0.9rem" }}>
      <div className="panel stack" style={{ gap: "0.6rem", padding: "0.7rem" }}>
        <strong style={{ fontSize: "0.86rem" }}>{t("Your stream overlay", "Votre overlay de stream")}</strong>
        <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
          {t(
            "Your game, webcam, fire board and fleet inside the Elden Battleship frame - one download, one import. It follows you from match to match, so you set it up once for the whole event.",
            "Votre jeu, votre webcam, votre plateau de tir et votre flotte dans le cadre Elden Battleship - un téléchargement, un import. Il vous suit de partie en partie, vous le configurez donc une fois pour tout l'événement.",
          )}
        </span>

        {!mine.signedIn || !mine.token ? (
          <OverlayTokenStart mine={mine} />
        ) : (
          <>
            <PlayerSceneSetup base={base} token={mine.token} />
            <OverlayTokenBox mine={mine} token={mine.token} />
          </>
        )}
        <OverlayTokenError mine={mine} />
      </div>

      <WatchLinkBox />

      <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45, textAlign: "center" }}>
        {t("Want the elements without the frame, or auto-marking with Dionysus Arcade? They're on the", "Vous voulez les éléments sans le cadre, ou le marquage automatique avec Dionysus Arcade ? Ils sont sur la")}{" "}
        <Link to="/streaming">{t("full OBS page", "page OBS complète")}</Link>.
      </span>
    </div>
  );
}
