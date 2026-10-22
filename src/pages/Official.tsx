import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { fetchEventsForMatches, fetchOfficialParticipants, fetchProfiles, type Profile } from "../lib/profiles";
import { fetchStatsEvents, type StatsEvent } from "../lib/tournament/api";
import { aggregateCareers, type OfficialParticipantRow } from "../lib/careerStats";
import { squarePace } from "../lib/squarePace";
import type { MatchEventRow } from "../lib/almanac";
import { CareerStandings, toStandingsRows, type StandingsScope } from "../components/CareerStandings";
import { LoadingScreen } from "../components/BrandMark";
import { SiteFooter } from "../components/SiteFooter";
import { useRatedPlayers, type RatedPlayer } from "../hooks/useRatedPlayers";
import { useT } from "../lib/language";

/** One tournament as the picker shows it: the event it started as, plus any divisions split off it. */
interface Tournament {
  root: StatsEvent;
  /** Every division, oldest first, the root included. A single entry means it was never split. */
  divisions: StatsEvent[];
}

/** Groups divisions under the event they were split from, newest tournament first. */
function groupTournaments(events: StatsEvent[]): Tournament[] {
  const byRoot = new Map<string, StatsEvent[]>();
  for (const e of events) {
    const root = e.division_of ?? e.id;
    byRoot.set(root, [...(byRoot.get(root) ?? []), e]);
  }
  const out: Tournament[] = [];
  for (const [rootId, list] of byRoot) {
    const divisions = [...list].sort((a, b) => a.went_live_at.localeCompare(b.went_live_at));
    // A root that never went live (or is hidden) while a division did: the oldest division stands in.
    const root = list.find((e) => e.id === rootId) ?? divisions[0];
    out.push({ root, divisions });
  }
  return out.sort((a, b) => b.root.went_live_at.localeCompare(a.root.went_live_at));
}

/**
 * Official tournament stats: the leaderboard's standings table, counted over official matches only -
 * once across every tournament, and once for the tournament picked.
 *
 * Kept apart from the ordinary leaderboard because an official match is a different kind of game - a
 * real bracket match, between rostered teams - and folding it into the everyday numbers would blur
 * both. Neither table is split by square set the way the leaderboard is: an event fixes its own board,
 * and the record is the event's. No Elo column - see StandingsScope.
 *
 * Reads only the official slice of the archive (fetchOfficialParticipants) and only those matches'
 * shots, never the whole log, so the page stays cheap however big the archive grows.
 */
export function Official() {
  const t = useT();
  const [rows, setRows] = useState<OfficialParticipantRow[] | null>(null);
  const [events, setEvents] = useState<StatsEvent[] | null>(null);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [shots, setShots] = useState<MatchEventRow[] | null>(null);
  const rated = useRatedPlayers();

  /** The tournament picked, by root id, and the division within it - null for all of its divisions. */
  const [pickedRoot, setPickedRoot] = useState<string | null>(null);
  const [pickedDivision, setPickedDivision] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Reads never break the page: a failure here is an empty board, not an error screen.
      const [data, list] = await Promise.all([
        fetchOfficialParticipants().catch(() => [] as OfficialParticipantRow[]),
        fetchStatsEvents().catch(() => [] as StatsEvent[]),
      ]);
      if (cancelled) return;
      setRows(data);
      setEvents(list);
      setProfiles(await fetchProfiles(data.map((r) => r.user_id).filter(Boolean) as string[]));
      const log = await fetchEventsForMatches(data.map((r) => r.match_key)).catch(() => [] as MatchEventRow[]);
      if (!cancelled) setShots(log);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tournaments = useMemo(() => groupTournaments(events ?? []), [events]);
  const tournament = tournaments.find((x) => x.root.id === pickedRoot) ?? tournaments[0] ?? null;
  const division = tournament?.divisions.find((d) => d.id === pickedDivision) ?? null;

  const eventRows = useMemo(() => {
    if (!tournament) return [];
    const ids = new Set((division ? [division] : tournament.divisions).map((d) => d.id));
    return (rows ?? []).filter((r) => r.tournament_id !== null && ids.has(r.tournament_id));
  }, [rows, tournament, division]);

  if (rows === null || events === null) {
    return <LoadingScreen>{t("Loading the official record...", "Chargement du palmarès officiel...")}</LoadingScreen>;
  }

  const pick = (rootId: string) => {
    setPickedRoot(rootId);
    setPickedDivision(null);
  };

  return (
    <div className="stack" style={{ width: "min(860px, 100%)" }}>
      <div style={{ textAlign: "center" }}>
        <h1>{t("Official record", "Palmarès officiel")}</h1>
        <p className="muted">
          {t("Official tournament matches only.", "Matchs officiels de tournoi uniquement.")}{" "}
          <Link to="/leaderboard">{t("Everyday leaderboard", "Classement général")}</Link>
        </p>
      </div>

      {tournaments.length === 0 ? (
        <div className="panel stack" style={{ alignItems: "center", textAlign: "center" }}>
          <p className="muted" style={{ margin: 0 }}>
            {t(
              "No tournament has gone live yet. Once one does, its official matches are counted here.",
              "Aucun tournoi n'a encore commencé. Dès qu'un tournoi commence, ses matchs officiels sont comptés ici."
            )}
          </p>
        </div>
      ) : (
        <>
          <StandingsPanel
            title={t("All tournaments", "Tous les tournois")}
            blurb={t("Every official match, in every tournament.", "Tous les matchs officiels, de tous les tournois.")}
            scope="official"
            rows={rows}
            shots={shots}
            profiles={profiles}
            rated={rated}
          />

          {tournament && (
            <StandingsPanel
              title={t("By tournament", "Par tournoi")}
              blurb={
                <Link to={`/event/${encodeURIComponent((division ?? tournament.root).id)}`}>
                  {t("Open the event page", "Ouvrir la page de l'événement")}
                </Link>
              }
              scope="event"
              rows={eventRows}
              shots={shots}
              profiles={profiles}
              rated={rated}
              picker={
                <>
                  <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
                    {tournaments.map((x) => (
                      <PickButton key={x.root.id} on={x === tournament} onClick={() => pick(x.root.id)}>
                        {x.root.name}
                      </PickButton>
                    ))}
                  </div>
                  {/* Only for a tournament that was split: one with a single division has nothing to pick. */}
                  {tournament.divisions.length > 1 && (
                    <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
                      <PickButton on={division === null} onClick={() => setPickedDivision(null)}>
                        {t("All divisions", "Toutes les divisions")}
                      </PickButton>
                      {tournament.divisions.map((d) => (
                        <PickButton key={d.id} on={d === division} onClick={() => setPickedDivision(d.id)}>
                          {d.division_name || d.name}
                        </PickButton>
                      ))}
                    </div>
                  )}
                </>
              }
            />
          )}
        </>
      )}
      <SiteFooter />
    </div>
  );
}

/** The same small toggle the leaderboard uses for Career / Per Game. */
function PickButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderColor: on ? "var(--accent)" : undefined }}
    >
      {children}
    </button>
  );
}

/** One standings table in its panel, built from whichever official rows it is handed. */
function StandingsPanel({
  title,
  blurb,
  scope,
  rows,
  shots,
  profiles,
  rated,
  picker,
}: {
  title: string;
  blurb: ReactNode;
  scope: StandingsScope;
  rows: OfficialParticipantRow[];
  /** The shot log for every official match, or null while it is still loading. */
  shots: MatchEventRow[] | null;
  profiles: Map<string, Profile>;
  rated: Map<string, RatedPlayer> | null;
  picker?: ReactNode;
}) {
  const t = useT();
  const careers = useMemo(() => {
    const keys = new Set(rows.map((r) => r.match_key));
    const paces = squarePace((shots ?? []).filter((e) => keys.has(e.match_key)));
    return toStandingsRows(aggregateCareers(rows), paces, profiles, rated);
  }, [rows, shots, profiles, rated]);

  return (
    <div className="panel stack" style={{ borderColor: "rgba(217, 164, 65, 0.55)", gap: "0.6rem" }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {picker}
      <span className="muted" style={{ fontSize: "0.78rem" }}>
        {blurb}
      </span>
      {careers.length === 0 ? (
        <span className="muted">{t("No official matches have been played yet.", "Aucun match officiel n'a encore été joué.")}</span>
      ) : (
        <CareerStandings
          careers={careers}
          profiles={profiles}
          scope={scope}
          ratingsLoading={rated === null}
          paceLoading={shots === null}
        />
      )}
      <span className="muted" style={{ fontSize: "0.7rem" }}>
        {t(
          "Click a heading to sort; click again to flip. Hover a heading for what the number means.",
          "Cliquez sur un en-tête pour trier ; cliquez à nouveau pour inverser. Survolez un en-tête pour voir ce que le nombre signifie."
        )}
      </span>
    </div>
  );
}
