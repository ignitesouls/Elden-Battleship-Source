import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminFreeAgents,
  adminTeams,
  fetchEvent,
  fetchEventConfig,
  fetchOverdue,
  fetchStoredMatches,
  type AdminTeamRow,
  type EventConfig,
  type EventDetail,
  type FreeAgentRow,
  type OverdueRow,
  type StoredMatches,
} from "../../../lib/tournament/api";

export interface DeskData {
  loading: boolean;
  error: string | null;
  event: EventDetail | null;
  config: EventConfig | null;
  /** Every team including pending and rejected. */
  teams: AdminTeamRow[];
  /** The teams in the event, best seed first. */
  seeded: AdminTeamRow[];
  /** Ids of teams an administrator has removed. */
  departed: Set<string>;
  names: Map<string, string>;
  stored: StoredMatches | null;
  agents: FreeAgentRow[];
  overdue: OverdueRow[];
  reload: () => void;
}

/**
 * Everything the running-event desk shows, read together so the panels always agree with each other.
 * One reload re-reads all of it, which is what every action does when it finishes - an administrator
 * who has just entered a result should see the standings, the overdue list and the next round's
 * availability all move at once, not each on its own timer.
 */
export function useDeskData(eventId: string): DeskData {
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const [state, setState] = useState<Omit<DeskData, "reload" | "seeded" | "departed" | "names">>({
    loading: true,
    error: null,
    event: null,
    config: null,
    teams: [],
    stored: null,
    agents: [],
    overdue: [],
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const event = await fetchEvent(eventId);
        if (!event) {
          if (!cancelled) setState((s) => ({ ...s, loading: false, event: null, error: null }));
          return;
        }
        const [config, teams, stored, agents, overdue] = await Promise.all([
          fetchEventConfig(eventId),
          adminTeams(eventId),
          fetchStoredMatches(eventId),
          adminFreeAgents(eventId),
          event.status === "live" ? fetchOverdue(eventId) : Promise.resolve([]),
        ]);
        if (!cancelled) setState({ loading: false, error: null, event, config, teams, stored, agents, overdue });
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, tick]);

  const seeded = useMemo(
    () =>
      state.teams
        .filter((t) => t.status === "approved")
        .sort((a, b) => (a.seed ?? Infinity) - (b.seed ?? Infinity)),
    [state.teams],
  );
  const departed = useMemo(() => new Set(state.teams.filter((t) => t.forfeited_at).map((t) => t.id)), [state.teams]);
  const names = useMemo(() => new Map(state.teams.map((t) => [t.id, t.name])), [state.teams]);

  return { ...state, seeded, departed, names, reload };
}
