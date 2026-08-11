import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { rowSquareSet, busiestSquareSet, squareSet, DEFAULT_SQUARE_SET } from "../lib/challenges";
import { fetchParticipants, fetchProfiles, fetchMatchEvents, profileName, type Profile } from "../lib/profiles";
import { playerPace, playerKills, playerBestKills, type MatchEventRow } from "../lib/almanac";
import { LoadingScreen } from "../components/BrandMark";
import {
  aggregateCareers,
  headToHeadRecords,
  teammateRecords,
  findNemesis,
  findBestTeammate,
  participantKey,
  type ParticipantRow,
} from "../lib/careerStats";

export function PlayerStats() {
  const { key: rawKey } = useParams<{ key: string }>();
  const playerKey = decodeURIComponent(rawKey ?? "");
  const [rows, setRows] = useState<ParticipantRow[] | null>(null);
  const [events, setEvents] = useState<MatchEventRow[]>([]);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());

  // Which board's career this is. Comes in on the link from the leaderboard so the two agree; on a
  // bare /player/<key> link it falls back to whichever set that player has played most.
  const [params] = useSearchParams();
  const [allRows, setAllRows] = useState<ParticipantRow[] | null>(null);
  const requestedSet = params.get("set");

  useEffect(() => {
    void (async () => {
      const [data, evs] = await Promise.all([fetchParticipants(), fetchMatchEvents()]);
      setAllRows(data);
      setEvents(evs as unknown as MatchEventRow[]);
      setProfiles(await fetchProfiles(data.map((r) => r.user_id).filter(Boolean) as string[]));
    })();
  }, []);

  const shownSet = useMemo(() => {
    if (requestedSet && squareSet(requestedSet).id === requestedSet) return requestedSet;
    const mine = (allRows ?? []).filter((r) => participantKey(r) === playerKey);
    return mine.length > 0 ? busiestSquareSet(mine) : DEFAULT_SQUARE_SET;
  }, [requestedSet, allRows, playerKey]);

  // Everything below reads `rows`, which is now one board's worth. Mixing them would put an
  // objectives accuracy in the same average as a boss one and describe neither.
  useEffect(() => {
    if (allRows === null) return;
    setRows(allRows.filter((r) => rowSquareSet(r) === shownSet));
  }, [allRows, shownSet]);

  // Per-square attribution: which bosses this player took, and how quickly.
  const myPace = useMemo(() => playerPace(events).find((p) => p.key === playerKey) ?? null, [events, playerKey]);
  const bestKills = useMemo(() => playerBestKills(events, playerKey, 5), [events, playerKey]);
  const killLog = useMemo(() => playerKills(events, playerKey).slice(0, 15), [events, playerKey]);

  const view = useMemo(() => {
    if (!rows) return null;
    const career = aggregateCareers(rows).find((c) => c.key === playerKey) ?? null;
    return {
      career,
      h2h: headToHeadRecords(rows, playerKey),
      mates: teammateRecords(rows, playerKey),
      nemesis: findNemesis(rows, playerKey),
      bestMate: findBestTeammate(rows, playerKey),
      recent: rows.filter((r) => participantKey(r) === playerKey).slice(0, 10),
    };
  }, [rows, playerKey]);

  if (rows === null) return <LoadingScreen>Loading the log...</LoadingScreen>;
  if (!view?.career) {
    return (
      <div className="panel stack" style={{ alignItems: "center", textAlign: "center" }}>
        <p className="muted" style={{ margin: 0 }}>No record found for this captain.</p>
        <Link to="/leaderboard">Back to the leaderboard</Link>
      </div>
    );
  }

  const { career, h2h, nemesis, bestMate, recent } = view;
  const profile = career.userId ? profiles.get(career.userId) : undefined;
  const awardList = Object.entries(career.awards).sort((a, b) => b[1] - a[1]);
  const num = { padding: "0.25rem 0.4rem", fontVariantNumeric: "tabular-nums" as const };

  return (
    <div className="stack" style={{ width: "min(760px, 100%)", gap: "0.9rem" }}>
      <div className="panel row" style={{ gap: "0.75rem", alignItems: "center" }}>
        {profile?.avatar_url && (
          <img
            src={profile.avatar_url}
            alt=""
            width={56}
            height={56}
            style={{ borderRadius: "50%", border: "2px solid var(--accent)" }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: "1.5rem" }}>{profileName(profile) ?? career.nickname}</h1>
          <span className="muted" style={{ fontSize: "0.82rem" }}>
            {career.wins}W - {career.losses}L{career.draws > 0 ? ` - ${career.draws}D` : ""} ·{" "}
            {Math.round(career.winRate * 100)}% win rate · {career.matches} matches
            {!career.verified && " · guest record"}
          </span>
          {/* Named explicitly: these numbers are one board's, and the same captain will have a
              different record on the other. */}
          <div className="muted" style={{ fontSize: "0.72rem" }}>
            {squareSet(shownSet).label} board
          </div>
        </div>
        <Link to="/leaderboard" style={{ fontSize: "0.8rem" }}>
          Leaderboard
        </Link>
      </div>

      <div className="panel stack" style={{ gap: "0.4rem" }}>
        <h3 style={{ margin: 0 }}>Career</h3>
        <div className="row" style={{ gap: "0.6rem", flexWrap: "wrap" }}>
          <Stat label="Shots fired" value={career.shots} />
          <Stat label="Hits" value={career.hits} color="var(--hit)" />
          <Stat label="Misses" value={career.misses} color="var(--text-dim)" />
          <Stat label="Ships sunk" value={career.sunk} color="var(--sunk)" />
          <Stat label="Accuracy" value={`${Math.round(career.accuracy * 100)}%`} />
          <Stat label="Ships lost" value={career.shipsLost} />
          {myPace && <Stat label="Square pace" value={fmtTime(myPace.secondsPerShot)} />}
          {myPace?.bestMatch && <Stat label="Best pace" value={fmtTime(myPace.bestMatch.seconds)} color="var(--accent)" />}
        </div>
      </div>

      {bestKills.length > 0 && (
        <div className="panel stack" style={{ gap: "0.25rem" }}>
          <h3 style={{ margin: 0 }}>Personal bests</h3>
          <span className="muted" style={{ fontSize: "0.7rem" }}>
            Quickest squares this captain has taken, timed from when firing opened - hits and misses alike.
          </span>
          {bestKills.map((k, i) => (
            <div
              key={`${k.matchKey}-${k.challenge}-${i}`}
              className="row"
              style={{ justifyContent: "space-between", fontSize: "0.82rem", gap: "0.5rem" }}
            >
              <span style={{ minWidth: 0 }}>
                <span className="muted">{i + 1}. </span>
                <strong>{k.challenge ?? "Unknown square"}</strong>
                {k.result === "sunk" && <span style={{ color: "var(--sunk)" }}> · sank a ship</span>}
                {k.result === "hit" && <span style={{ color: "var(--hit)" }}> · hit</span>}
              </span>
              <strong style={{ color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}>{fmtTime(k.seconds)}</strong>
            </div>
          ))}
        </div>
      )}

      {killLog.length > 0 && (
        <div className="panel stack" style={{ gap: "0.25rem" }}>
          <h3 style={{ margin: 0 }}>Square log</h3>
          <span className="muted" style={{ fontSize: "0.7rem" }}>
            Every square taken, most recent match first.
          </span>
          <div style={{ maxHeight: "18rem", overflowY: "auto" }} className="stack">
            {killLog.map((k, i) => (
              <div
                key={`${k.matchKey}-${k.challenge}-${i}`}
                className="row"
                style={{ justifyContent: "space-between", fontSize: "0.8rem", gap: "0.5rem" }}
              >
                <span style={{ minWidth: 0 }}>
                  <strong
                    style={{
                      color:
                        k.result === "sunk" ? "var(--sunk)" : k.result === "hit" ? "var(--hit)" : "var(--text-dim)",
                    }}
                  >
                    {k.result === "sunk" ? "SANK" : k.result === "hit" ? "HIT" : "miss"}
                  </strong>
                  <span> {k.challenge ?? "Unknown square"}</span>
                </span>
                <span className="muted" style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                  {fmtTime(k.seconds)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(nemesis || bestMate) && (
        <div className="row" style={{ gap: "0.75rem", alignItems: "stretch" }}>
          {nemesis && (
            <div className="panel stack" style={{ flex: 1, minWidth: 0, gap: "0.2rem" }}>
              <span className="muted" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                ☠ Nemesis
              </span>
              <Link to={`/player/${encodeURIComponent(nemesis.key)}`} style={{ fontSize: "1.05rem", fontWeight: 700 }}>
                {nemesis.nickname}
              </Link>
              <span className="muted" style={{ fontSize: "0.78rem" }}>
                Beaten you {nemesis.losses} of {nemesis.played} - you win {Math.round(nemesis.winRate * 100)}%
              </span>
            </div>
          )}
          {bestMate && (
            <div className="panel stack" style={{ flex: 1, minWidth: 0, gap: "0.2rem" }}>
              <span className="muted" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                ⚓ Best shipmate
              </span>
              <Link to={`/player/${encodeURIComponent(bestMate.key)}`} style={{ fontSize: "1.05rem", fontWeight: 700 }}>
                {bestMate.nickname}
              </Link>
              <span className="muted" style={{ fontSize: "0.78rem" }}>
                {bestMate.wins} wins together from {bestMate.played} - {Math.round(bestMate.winRate * 100)}%
              </span>
            </div>
          )}
        </div>
      )}

      {awardList.length > 0 && (
        <div className="panel stack" style={{ gap: "0.3rem" }}>
          <h3 style={{ margin: 0 }}>Honors</h3>
          {awardList.map(([title, count]) => (
            <div key={title} className="row" style={{ justifyContent: "space-between", fontSize: "0.84rem" }}>
              <span>{title}</span>
              <strong style={{ color: "var(--accent)" }}>x{count}</strong>
            </div>
          ))}
        </div>
      )}

      {h2h.length > 0 && (
        <div className="panel stack" style={{ gap: "0.3rem" }}>
          <h3 style={{ margin: 0 }}>Head to head</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
              <thead>
                <tr style={{ color: "var(--text-dim)", textAlign: "right" }}>
                  <th style={{ textAlign: "left", fontWeight: 500, padding: "0.25rem 0.4rem" }}>Opponent</th>
                  <th style={{ fontWeight: 500, padding: "0.25rem 0.4rem" }}>Played</th>
                  <th style={{ fontWeight: 500, padding: "0.25rem 0.4rem" }}>W-L</th>
                  <th style={{ fontWeight: 500, padding: "0.25rem 0.4rem" }}>Win %</th>
                </tr>
              </thead>
              <tbody>
                {h2h.map((h) => (
                  <tr key={h.key} style={{ textAlign: "right", borderTop: "1px solid var(--panel-border)" }}>
                    <td style={{ textAlign: "left", padding: "0.25rem 0.4rem" }}>
                      <Link to={`/player/${encodeURIComponent(h.key)}`}>{h.nickname}</Link>
                    </td>
                    <td style={num}>{h.played}</td>
                    <td style={num}>
                      {h.wins}-{h.losses}
                    </td>
                    <td style={num}>{Math.round(h.winRate * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="panel stack" style={{ gap: "0.25rem" }}>
          <h3 style={{ margin: 0 }}>Recent matches</h3>
          {recent.map((r) => (
            <div
              key={r.match_key}
              className="row"
              style={{ justifyContent: "space-between", fontSize: "0.8rem", gap: "0.5rem" }}
            >
              <span style={{ minWidth: 0 }}>
                <strong style={{ color: r.draw ? "var(--text-dim)" : r.won ? "var(--accent)" : "var(--danger)" }}>
                  {r.draw ? "DRAW" : r.won ? "WIN" : "LOSS"}
                </strong>
                <span className="muted">
                  {" "}
                  · {r.shots} shots, {r.hits} hits, {r.sunk} sunk
                </span>
              </span>
              <span className="muted" style={{ whiteSpace: "nowrap", fontSize: "0.72rem" }}>
                {new Date(r.finished_at).toLocaleDateString([], { month: "short", day: "numeric" })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** m:ss - pace and kill times read as durations, not raw second counts. */
function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Stat({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="stack" style={{ gap: 0, minWidth: "5.5rem" }}>
      <span style={{ fontSize: "1.3rem", fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{value}</span>
      <span className="muted" style={{ fontSize: "0.7rem" }}>{label}</span>
    </div>
  );
}
