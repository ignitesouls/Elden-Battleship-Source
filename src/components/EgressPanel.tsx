import { useEffect, useState } from "react";
import {
  listRoomEgress,
  fetchBilledEgress,
  matchWindow,
  bytes,
  type RoomEgress,
  type BilledEgress,
} from "../lib/egress";
import { formatRoomCode } from "../lib/roomCode";
import type { MatchReportRow } from "../types/battleship";

/** Rows per page, matching the archived-match list this panel sits under. */
const PAGE = 25;

/**
 * What each match cost in bytes.
 *
 * -- Why there are two numbers and not one -----------------------------------------------------------
 *
 * They measure different halves and neither can see the other's:
 *
 *   Measured   summed from what every browser tab in the room reported receiving. This is the ONLY
 *              source for realtime, which is the fan-out that dominates a live match and which
 *              Supabase does not log a byte count for at any plan.
 *   Billed     Supabase's own `edge_logs`, windowed to the match. Exact for REST, auth and storage.
 *              Blind to realtime.
 *
 * So they are shown side by side and never summed - adding them would double-count REST and add
 * nothing. Where they overlap, on REST, the gap between them is the useful part: it says how much of
 * the traffic came from tabs that never reported, and it is a standing check on the client meter.
 *
 * -- Why the billed half is behind a button -----------------------------------------------------------
 *
 * It is a Management API call per match, made by an edge function holding an org-wide token, against
 * a log store with a day of retention on Free. Loading it for forty rows on every visit to this page
 * would be slow, mostly useless (most rows are past retention) and a lot of calls. Asked for one
 * match at a time, it is one round trip for the match somebody is actually asking about.
 */
export function EgressPanel({ matches }: { matches: MatchReportRow[] }) {
  const [rooms, setRooms] = useState<RoomEgress[] | null>(null);
  /** How many rows to ask for. Raised by "Show more", in step with the match list above. */
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const [billed, setBilled] = useState<Record<string, BilledEgress | string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => setRooms(await listRoomEgress(limit)))();
  }, [limit]);

  // No count query behind this. A short page is proof there is nothing more; a full one only means
  // there might be, and offering a button that turns out to add nothing is a smaller cost than a
  // round trip on every visit to find out.
  const maybeMore = rooms !== null && rooms.length >= limit;

  async function askBilled(row: RoomEgress) {
    const key = row.room_code ?? "";
    const match = matchForRoom(row, matches);
    if (!match) {
      // The match list above is paged, so "no match" has two meanings and they need different
      // answers: this room may predate what has been loaded rather than have no match at all.
      // Saying the wrong one sends an admin looking for a bug in the join.
      const oldestLoaded = matches.length
        ? new Date(matches[matches.length - 1].finished_at).getTime()
        : null;
      const notLoadedYet = oldestLoaded !== null && new Date(row.last_seen).getTime() < oldestLoaded;
      setBilled((b) => ({
        ...b,
        [key]: notLoadedYet
          ? "This room is older than the matches loaded above. Press Show more on the archived list, then ask again."
          : "No archived match lines up with these samples. A room that was opened and abandoned still spends bytes, but there is no window to ask Supabase about.",
      }));
      return;
    }
    const window = matchWindow(match.match_key, match.finished_at);
    if (!window) {
      setBilled((b) => ({ ...b, [key]: "Couldn't read a start time off that match key." }));
      return;
    }

    setBusy(true);
    const res = await fetchBilledEgress(window.startedAt, window.endedAt);
    setBusy(false);

    if (!res.ok) {
      setBilled((b) => ({ ...b, [key]: reasonText(res.reason) }));
      return;
    }
    if (res.data.retentionWarning) {
      setBilled((b) => ({
        ...b,
        [key]:
          "No log rows in that window. Supabase keeps them for one day on Free and seven on Pro, so this match has almost certainly aged out - which is not the same as it having cost nothing.",
      }));
      return;
    }
    setBilled((b) => ({ ...b, [key]: res.data }));
  }

  return (
    <div className="panel stack" style={{ gap: "0.7rem", width: "100%" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: "1rem" }}>Egress</h2>
        <button
          disabled={busy}
          style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem" }}
          onClick={() => void (async () => setRooms(await listRoomEgress(limit)))()}
        >
          Refresh
        </button>
      </div>

      <p className="muted" style={{ margin: 0, fontSize: "0.76rem" }}>
        What each room's watchers downloaded, reported by their own browsers. Realtime is counted
        here and nowhere else - Supabase publishes no byte count for websocket traffic, at any plan -
        and those frames are uncompressed, so that figure is the real one. REST is a floor: PostgREST
        sends no length header, so the number is re-compressed client-side and reads 10-30% low.
        "Billed" asks Supabase what it actually sent over the same window, which is exact for REST
        and blind to realtime. The two are not added together.
      </p>

      {rooms === null && (
        <span className="muted" style={{ fontSize: "0.78rem" }}>Reading the samples...</span>
      )}

      {rooms?.length === 0 && (
        <span className="muted" style={{ fontSize: "0.78rem" }}>
          Nothing reported yet. Rows appear a minute into the next match played on a build that
          carries the meter.
        </span>
      )}

      {rooms?.map((r) => {
        const key = r.room_code ?? "(no room)";
        const total = r.rest_bytes + r.realtime_bytes;
        const detail = billed[key];
        const isOpen = open === key;
        const match = matchForRoom(r, matches);
        return (
          <div key={key} className="stack" style={{ gap: "0.25rem" }}>
            <div
              className="row"
              style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.78rem" }}
            >
              <span style={{ minWidth: 0, flex: 1 }}>
                <strong>{r.room_code ? formatRoomCode(r.room_code) : "(no room)"}</strong>
                <span className="muted">
                  {" "}
                  · {bytes(total)} total · {bytes(r.realtime_bytes)} realtime ·{" "}
                  {/* A floor, not a figure. PostgREST sends no Content-Length, so the client
                      re-compresses each body to weigh it and lands 10-30% under what the gateway
                      actually put on the wire - see weigh() in lib/egressMeter. The greater-than
                      sign is the whole disclosure at a glance; "Billed" gets the real number. */}
                  &ge;{bytes(r.rest_bytes)} REST
                </span>
              </span>
              <button
                disabled={busy}
                style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
                onClick={() => {
                  setOpen((k) => (k === key ? null : key));
                  if (!isOpen && !billed[key]) void askBilled(r);
                }}
              >
                {isOpen ? "Hide" : "Billed"}
              </button>
            </div>

            <span className="muted" style={{ fontSize: "0.7rem" }}>
              {/* Named where the samples line up with an archived game, so a row reads as "that
                  match" rather than as a room code somebody has to go and look up. A room that was
                  opened and abandoned has no match and says so by omission. */}
              {match ? `${match.duration ?? "--:--"} · ${match.total_shots} shots · ` : ""}
              {r.clients} tab{r.clients === 1 ? "" : "s"}
              {r.players > 0 && ` · ${r.players} player`}
              {r.spectators > 0 && ` · ${r.spectators} spectator`}
              {r.overlays > 0 && ` · ${r.overlays} overlay`}
              {r.casters > 0 && ` · ${r.casters} caster`}
              {" · "}
              {r.realtime_messages.toLocaleString()} frames · {r.rest_requests.toLocaleString()}{" "}
              requests
              {/* Responses with no Content-Length were weighed after decompression, which overstates
                  gzipped JSON several times over. Said out loud rather than folded into the total,
                  because a row where this is most of the requests is not really a measurement. */}
              {r.rest_estimated > 0 && ` · ${r.rest_estimated.toLocaleString()} uncompressed est.`}
              {" · "}
              {new Date(r.last_seen).toLocaleString()}
            </span>

            {isOpen && (
              <div
                className="stack"
                style={{ gap: "0.2rem", fontSize: "0.72rem", paddingLeft: "0.6rem" }}
              >
                {busy && !detail && <span className="muted">Asking Supabase...</span>}
                {typeof detail === "string" && (
                  <span className="muted" style={{ color: "var(--danger)" }}>{detail}</span>
                )}
                {detail && typeof detail !== "string" && (
                  <>
                    <span>
                      <strong>{bytes(detail.bytes)}</strong>{" "}
                      <span className="muted">
                        billed REST over {detail.requests.toLocaleString()} requests, against{" "}
                        {bytes(r.rest_bytes)} the tabs reported. Realtime is not in this number.
                      </span>
                    </span>
                    {detail.withoutLength > 0 && (
                      <span className="muted">
                        {detail.withoutLength.toLocaleString()} response
                        {detail.withoutLength === 1 ? "" : "s"} carried no Content-Length and counted
                        as zero, so the figure above is a floor.
                      </span>
                    )}
                    {detail.byPath.map((p) => (
                      <div
                        key={p.path}
                        className="row"
                        style={{ justifyContent: "space-between", gap: "0.5rem" }}
                      >
                        <span className="muted" style={{ minWidth: 0, flex: 1 }}>
                          {p.path}
                        </span>
                        <span style={{ flex: "none" }}>
                          {bytes(p.bytes)}{" "}
                          <span className="muted">({p.requests.toLocaleString()})</span>
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}

      {maybeMore && (
        <button
          disabled={busy}
          style={{ fontSize: "0.72rem", padding: "0.25rem 0.5rem", alignSelf: "center" }}
          onClick={() => setLimit((n) => n + PAGE)}
        >
          Show more
        </button>
      )}

      <span className="muted" style={{ fontSize: "0.7rem" }}>
        Samples are dropped after thirty days. The billed half needs EGRESS_MANAGEMENT_TOKEN set as
        a function secret, and only reaches back as far as log retention - one day on Free.
      </span>
    </div>
  );
}

/**
 * The archived match a room's samples belong to.
 *
 * The samples carry no match key and cannot - see the note on `room_code` in the egress_samples
 * migration - so the join is room code plus time: a match in the same room that FINISHED between the
 * first and last report is the one those tabs were watching.
 *
 * The window is opened out at both ends because the two clocks are measuring different things. The
 * archive's `finished_at` is written when the last shot lands; a tab keeps reporting for up to a
 * minute after that (the flush interval), and an overlay left open in OBS keeps reporting all
 * evening. Ten minutes of slack covers the flush and the tail without being wide enough to catch the
 * next match in a room that gets reused.
 *
 * The latest qualifying match wins, so a room played twice in one night is attributed to the second
 * game rather than the first - which is the one the samples that are still arriving belong to.
 */
function matchForRoom(row: RoomEgress, matches: MatchReportRow[]): MatchReportRow | null {
  if (!row.room_code) return null;
  const SLACK_MS = 10 * 60 * 1000;
  const from = new Date(row.first_seen).getTime() - SLACK_MS;
  const to = new Date(row.last_seen).getTime() + SLACK_MS;

  let best: MatchReportRow | null = null;
  for (const m of matches) {
    if (m.room_code !== row.room_code) continue;
    const at = new Date(m.finished_at).getTime();
    if (at < from || at > to) continue;
    if (!best || at > new Date(best.finished_at).getTime()) best = m;
  }
  return best;
}

/** The function's own refusals, in words. Anything else is passed through as it arrived. */
function reasonText(reason: string): string {
  if (reason === "no_management_token")
    return "No EGRESS_MANAGEMENT_TOKEN set on the project, so nothing can ask Supabase what it sent. Set it with: npx supabase secrets set EGRESS_MANAGEMENT_TOKEN=sbp_... --project-ref <ref>";
  if (reason === "not_admin") return "The server says you aren't an admin.";
  if (reason === "bad_window") return "That match's start and end don't make a window.";
  if (reason === "window_too_wide") return "That window is longer than a day.";
  return reason;
}
