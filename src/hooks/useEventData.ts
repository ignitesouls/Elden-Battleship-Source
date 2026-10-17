import { useCallback, useEffect, useMemo, useState } from "react";
import {
  entrantTwitch,
  fetchEvent,
  fetchEventConfig,
  fetchMatches,
  fetchStoredMatches,
  fetchTeams,
  teamLogos,
  type EventConfig,
  type EventDetail,
  type MatchRow,
  type TeamRow,
} from "../lib/tournament/api";
import { tableCuts } from "../lib/tournament/format";
import { qualifierStatus } from "../lib/tournament/stages";
import type { TMatch } from "../lib/tournament/types";
import { isSupabaseConfigured } from "../lib/supabase";
import { useTeamPowers } from "./useTeamPowers";
import { useProfileBits } from "./useProfileBits";

/** How often a running event is re-read, so results show up without a reload. */
const REFRESH_MS = 60_000;

/**
 * Everything a page about one event reads: the event, its teams and matches, the standings worked out
 * from them, team power, and each player's avatar and Twitch login.
 *
 * Shared by the event page and a crew's quarters, so the two always show the same table and the same
 * schedule. A running event is re-read every minute while the tab is visible, and again whenever the
 * signed-in account changes - which teams are visible depends on who is asking (a pending team is only
 * visible to its own members).
 *
 * `alwaysConfig` also reads the saved format before the event starts - only the rulebook needs it then.
 */
export function useEventData(id: string, userId: string | null, { alwaysConfig = false } = {}) {
  const [event, setEvent] = useState<EventDetail | null | undefined>(undefined);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [config, setConfig] = useState<EventConfig | null>(null);
  // The engine's view of the same matches plus the saved format, from which the standings are worked out.
  const [engine, setEngine] = useState<{ format: NonNullable<EventConfig["format"]>; matches: TMatch[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let cancelled = false;
    void (async () => {
      try {
        const found = await fetchEvent(id);
        if (cancelled) return;
        setEvent(found);
        if (!found) return;
        const wantsMatches = found.status === "live" || found.status === "finished";
        const [teamRows, matchRows, saved, stored] = await Promise.all([
          fetchTeams(id),
          wantsMatches ? fetchMatches(id) : Promise.resolve([]),
          wantsMatches || alwaysConfig ? fetchEventConfig(id) : Promise.resolve(null),
          wantsMatches ? fetchStoredMatches(id) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setTeams(teamRows);
        setMatches(matchRows);
        setConfig(saved);
        setEngine(saved?.format && stored ? { format: saved.format, matches: stored.matches } : null);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, tick, userId, alwaysConfig]);

  // A running event is re-read now and then. Nothing is fetched while the tab is hidden.
  const live = event?.status === "live";
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, reload]);

  // Standings for a Swiss or group qualifier, worked out by the same engine that decides who advances,
  // so the table a player reads is the table the knockout will be built from.
  const standings = useMemo(() => {
    if (!engine || engine.format.qualifier.format === "none") return null;
    const seededIds = teams
      .filter((team) => team.status === "approved")
      .sort((a, b) => (a.seed ?? Infinity) - (b.seed ?? Infinity))
      .map((team) => team.id);
    const gone = new Set(teams.filter((team) => team.forfeited_at).map((team) => team.id));
    const status = qualifierStatus(engine.format, seededIds, engine.matches, gone);
    return {
      tables: status.tables,
      grouped: engine.format.qualifier.format === "groups",
      // One per table: groups can send different numbers (a challenger group usually sends fewer).
      cuts: tableCuts(engine.format),
    };
  }, [engine, teams]);

  // Team power, for the team list and the lines on matches still to play. Approved teams only - the ones
  // in the event. Fetched again when a result comes in (the count of finished matches), not every refresh.
  const rosters = useMemo(
    () => new Map(teams.filter((team) => team.status === "approved").map((team) => [team.id, team.roster.map((m) => m.user_id)])),
    [teams],
  );
  const decided = matches.filter((m) => m.status === "done").length;
  const powers = useTeamPowers(event?.status === "cancelled" ? new Map() : rosters, decided);
  // Avatars (an individual event's logos) and Twitch logins (the streams links).
  const profileIds = useMemo(() => [...rosters.values()].flat(), [rosters]);
  const profiles = useProfileBits(profileIds);

  const names = useMemo(() => new Map(teams.map((team) => [team.id, team.name])), [teams]);
  // In an individual event each "team" is one player, shown with their Twitch avatar.
  const logos = useMemo(() => teamLogos(teams, event?.team_size === 1 ? profiles : undefined), [teams, event?.team_size, profiles]);
  // And their name is their own, so it links to their Twitch. Empty in a team event.
  const twitch = useMemo(() => entrantTwitch(teams, event?.team_size === 1 ? profiles : undefined), [teams, event?.team_size, profiles]);
  const departedIds = useMemo(() => new Set(teams.filter((team) => team.forfeited_at).map((team) => team.id)), [teams]);

  return { event, teams, matches, config, error, reload, standings, powers, profiles, names, logos, twitch, departedIds };
}
