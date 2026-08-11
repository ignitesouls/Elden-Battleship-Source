import { useEffect, useState } from "react";
import { serverNow } from "../lib/serverTime";
import {
  useAdminStatus,
  listAdmins,
  grantAdmin,
  revokeAdmin,
  deleteMatchRecord,
  deleteAllMatchRecords,
  exportRecords,
  countOrphans,
  deleteOrphans,
  listRooms,
  deleteRoom,
  pruneRooms,
  listMatchParticipants,
  removeParticipantFromMatch,
  listMatchShots,
  deleteMatchShot,
  updateMatchShotTime,
  type AdminRow,
  type LiveRoom,
  type MatchParticipant,
  type MatchShot,
} from "../lib/admin";
import { formatRoomCode } from "../lib/roomCode";
import { durationSeconds } from "../lib/matchName";
import { teamName, teamHex } from "../lib/teamColors";
import type { MatchReportRow } from "../types/battleship";

interface Props {
  matches: MatchReportRow[];
  /** Called after anything is deleted so the page can re-read its data. */
  onChanged: () => void;
}

/**
 * Record-book management, visible only to admins.
 *
 * Renders nothing at all for everyone else - including while the check is still in flight, so the
 * panel never flashes into view for an ordinary visitor. The real enforcement is RLS; this only
 * decides whether to offer controls that would otherwise fail.
 */
export function AdminPanel({ matches, onChanged }: Props) {
  const { isAdmin, isOwner, loading } = useAdminStatus();
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [rooms, setRooms] = useState<LiveRoom[]>([]);
  const [orphans, setOrphans] = useState(0);
  const [grantName, setGrantName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState("");
  /** Which match has its crew list open, and a counter to re-read it after a removal. */
  const [openMatch, setOpenMatch] = useState<string | null>(null);
  const [crewReload, setCrewReload] = useState(0);
  /** Same again for the shot log, which opens independently of the crew list. */
  const [openShots, setOpenShots] = useState<string | null>(null);
  const [shotReload, setShotReload] = useState(0);

  useEffect(() => {
    if (!isAdmin) return;
    listAdmins().then(setAdmins).catch(() => setAdmins([]));
    listRooms().then(setRooms).catch(() => setRooms([]));
    countOrphans().then(setOrphans).catch(() => setOrphans(0));
  }, [isAdmin, matches]);

  if (loading || !isAdmin) return null;

  async function refreshAdmins() {
    setAdmins(await listAdmins().catch(() => []));
  }

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    try {
      setNote(await fn());
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack" style={{ gap: "0.7rem", borderColor: "var(--danger)", width: "100%" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0, color: "var(--danger)" }}>Admin</h3>
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          {isOwner ? "Owner" : "Administrator"}
        </span>
      </div>

      {note && <div className="muted" style={{ fontSize: "0.78rem" }}>{note}</div>}

      {/* -- Records -- */}
      <div className="stack" style={{ gap: "0.35rem" }}>
        <strong style={{ fontSize: "0.82rem" }}>Archived matches ({matches.length})</strong>
        {matches.length === 0 && <span className="muted" style={{ fontSize: "0.78rem" }}>Nothing on record.</span>}
        {matches.map((m) => (
          <div key={m.id} className="stack" style={{ gap: "0.25rem" }}>
            <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.78rem" }}>
              <span style={{ minWidth: 0, flex: 1 }}>
                <strong style={{ color: m.winner_team !== null ? teamHex(m.winner_team) : "var(--text-dim)" }}>
                  {m.winner_team !== null ? teamName(m.winner_team) : "Draw"}
                </strong>
                <span className="muted">
                  {" "}
                  · {formatRoomCode(m.room_code)} · {m.duration ?? "--:--"} · {m.total_shots} shots ·{" "}
                  {new Date(m.finished_at).toLocaleString()}
                </span>
              </span>
              {/* Opens the crew list for this match. Deleting a whole game because one name on it
                  shouldn't be there wipes everybody else's record of it too, so the finer tool sits
                  right beside the blunt one. */}
              <button
                disabled={busy}
                style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
                onClick={() => setOpenMatch((k) => (k === m.match_key ? null : m.match_key))}
              >
                {openMatch === m.match_key ? "Hide crew" : "Crew"}
              </button>
              {/* Finer still than the crew list: one square somebody marked. A mismarked square
                  can hold a timing record outright, and this is the only thing that can take it
                  back without deleting everything either side of it. */}
              <button
                disabled={busy}
                style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
                onClick={() => setOpenShots((k) => (k === m.match_key ? null : m.match_key))}
              >
                {openShots === m.match_key ? "Hide shots" : "Shots"}
              </button>
              <button
                className="danger"
                disabled={busy}
                style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
                onClick={() =>
                  void run(async () => {
                    await deleteMatchRecord(m.match_key);
                    onChanged();
                    return `Deleted ${formatRoomCode(m.room_code)}.`;
                  })
                }
              >
                Delete
              </button>
            </div>

            {openMatch === m.match_key && (
              <MatchCrew
                matchKey={m.match_key}
                busy={busy}
                onRemove={(nickname) =>
                  void run(async () => {
                    await removeParticipantFromMatch(m.match_key, nickname);
                    setCrewReload((n) => n + 1);
                    onChanged();
                    return `Struck ${nickname} from ${formatRoomCode(m.room_code)}.`;
                  })
                }
                reload={crewReload}
              />
            )}

            {openShots === m.match_key && (
              <MatchShots
                matchKey={m.match_key}
                duration={m.duration}
                busy={busy}
                onDelete={(shot) =>
                  void run(async () => {
                    await deleteMatchShot(shot);
                    setShotReload((n) => n + 1);
                    onChanged();
                    return `Deleted ${shot.nickname}'s shot on ${shot.challenge_name ?? `square ${shot.cell_index}`}.`;
                  })
                }
                onRetime={(shot, seconds) =>
                  void run(async () => {
                    await updateMatchShotTime(shot, seconds);
                    setShotReload((n) => n + 1);
                    onChanged();
                    const square = shot.challenge_name ?? `square ${shot.cell_index}`;
                    const was = shot.match_seconds === null ? "--:--" : clock(shot.match_seconds);
                    return `Moved ${shot.nickname}'s shot on ${square} from ${was} to ${clock(seconds)}.`;
                  })
                }
                reload={shotReload}
              />
            )}
          </div>
        ))}
      </div>

      {/* Orphans: rows in the satellite tables whose parent report is gone. Surfaced separately
          because the list above is built from match_reports, so an orphan is invisible there while
          still counting on the leaderboard, which reads match_participants directly. */}
      {orphans > 0 && (
        <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", alignItems: "center" }}>
          <span className="muted" style={{ fontSize: "0.76rem", minWidth: 0, flex: 1 }}>
            <strong style={{ color: "var(--hit)" }}>{orphans} orphaned record row{orphans === 1 ? "" : "s"}</strong> -
            no parent match, but still counted on the leaderboard.
          </span>
          <button
            className="danger"
            disabled={busy}
            style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
            onClick={() => void run(async () => {
              const n = await deleteOrphans();
              setOrphans(await countOrphans().catch(() => 0));
              onChanged();
              return `Cleared ${n} orphaned record${n === 1 ? "" : "s"}.`;
            })}
          >
            Clear orphans
          </button>
        </div>
      )}

      {/* Offered above the wipe on purpose: the button below it cannot be undone, and there is no
          point-in-time restore on the free tier. */}
      <button
        disabled={busy}
        style={{ fontSize: "0.75rem" }}
        onClick={() => void run(async () => {
          await exportRecords();
          return "Downloaded a JSON backup of every record.";
        })}
      >
        Download backup (JSON)
      </button>

      {/* -- Wipe everything --
          Gated behind typing the word rather than a confirm() dialog: this clears every career
          record on the site with no undo and no backup, and a button you can hit by reflex is the
          wrong shape for that. */}
      {(matches.length > 0 || orphans > 0) && (
        <div className="stack" style={{ gap: "0.3rem" }}>
          {/* Offered when there are orphans even with zero matches - that combination is exactly
              the state where the list above looks empty but the leaderboard doesn't. */}
          <span className="muted" style={{ fontSize: "0.72rem" }}>
            Type <code>WIPE</code> to erase every record row
            {matches.length > 0 ? ` (${matches.length} match${matches.length === 1 ? "" : "es"})` : ""}. This cannot
            be undone.
          </span>
          <div className="row" style={{ gap: "0.4rem" }}>
            <input
              value={confirmWipe}
              onChange={(e) => setConfirmWipe(e.target.value)}
              placeholder="WIPE"
              style={{ flex: 1, minWidth: 0, fontSize: "0.78rem" }}
            />
            <button
              className="danger"
              disabled={busy || confirmWipe !== "WIPE"}
              style={{ fontSize: "0.75rem", flex: "none" }}
              onClick={() =>
                void run(async () => {
                  const n = await deleteAllMatchRecords();
                  setConfirmWipe("");
                  onChanged();
                  return `Erased ${n} match record${n === 1 ? "" : "s"}.`;
                })
              }
            >
              Erase all records
            </button>
          </div>
        </div>
      )}

      {/* -- Live rooms -- */}
      <div className="stack" style={{ gap: "0.35rem", borderTop: "1px solid var(--panel-border)", paddingTop: "0.6rem" }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <strong style={{ fontSize: "0.82rem" }}>Live rooms ({rooms.length}/15)</strong>
          <button
            disabled={busy}
            style={{ fontSize: "0.7rem", padding: "0.2rem 0.5rem" }}
            onClick={() => void run(async () => {
              const n = await pruneRooms();
              setRooms(await listRooms().catch(() => []));
              return `Pruned ${n} stale room${n === 1 ? "" : "s"}.`;
            })}
          >
            Prune stale
          </button>
        </div>
        {rooms.length === 0 && <span className="muted" style={{ fontSize: "0.78rem" }}>No rooms open.</span>}
        {rooms.map((r) => (
          <div key={r.id} className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.78rem" }}>
            <span style={{ minWidth: 0, flex: 1 }}>
              <strong>{formatRoomCode(r.code)}</strong>
              <span className="muted">
                {" "}
                · {r.status} · {r.players} player{r.players === 1 ? "" : "s"} ·{" "}
                {/* serverNow, not Date.now: created_at is a Postgres timestamp, so a skewed PC
                    clock would otherwise report rooms as older or younger than they are. */}
                {Math.round((serverNow() - new Date(r.created_at).getTime()) / 60000)}m old
              </span>
            </span>
            <button
              className="danger"
              disabled={busy}
              style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
              onClick={() => void run(async () => {
                await deleteRoom(r.id);
                setRooms(await listRooms().catch(() => []));
                return `Deleted room ${formatRoomCode(r.code)}.`;
              })}
            >
              Delete
            </button>
          </div>
        ))}
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          Deleting a room removes its players, fleets and attack log with it. Use it on a stuck
          room that's holding one of the 15 slots.
        </span>
      </div>

      {/* -- Admins -- */}
      <div className="stack" style={{ gap: "0.35rem", borderTop: "1px solid var(--panel-border)", paddingTop: "0.6rem" }}>
        <strong style={{ fontSize: "0.82rem" }}>Administrators</strong>
        {admins.map((a) => (
          <div key={a.user_id} className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.78rem" }}>
            <span>
              {a.display_name ?? a.user_id.slice(0, 8)}
              {a.is_owner && <span className="badge">owner</span>}
            </span>
            {/* Owners can only be removed by another owner - the rule RLS enforces, mirrored here
                so the button isn't offered when the server would reject it. */}
            {(!a.is_owner || isOwner) && (
              <button
                disabled={busy}
                style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
                onClick={() =>
                  void run(async () => {
                    await revokeAdmin(a.user_id);
                    await refreshAdmins();
                    return `Removed ${a.display_name ?? "that account"}.`;
                  })
                }
              >
                Revoke
              </button>
            )}
          </div>
        ))}

        <form
          className="row"
          style={{ gap: "0.4rem" }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const res = await grantAdmin(grantName);
              if (res.ok) {
                setGrantName("");
                await refreshAdmins();
              }
              return res.message;
            });
          }}
        >
          <input
            value={grantName}
            onChange={(e) => setGrantName(e.target.value)}
            placeholder="Twitch display name"
            style={{ flex: 1, minWidth: 0, fontSize: "0.78rem" }}
          />
          <button type="submit" disabled={busy} style={{ fontSize: "0.75rem", flex: "none" }}>
            Make admin
          </button>
        </form>
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          They must have signed in with Twitch here at least once, so the grant can be pinned to
          their account rather than to a name.
        </span>
      </div>
    </div>
  );
}

/**
 * The crew of one archived match, each with a way off it.
 *
 * Removing a name here takes their career row, their shots and their line in the recap, and leaves
 * the match standing for everyone else - see removeParticipantFromMatch.
 */
function MatchCrew({
  matchKey,
  busy,
  onRemove,
  reload,
}: {
  matchKey: string;
  busy: boolean;
  onRemove: (nickname: string) => void;
  reload: number;
}) {
  const [crew, setCrew] = useState<MatchParticipant[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMatchParticipants(matchKey)
      .then((rows) => !cancelled && setCrew(rows))
      .catch(() => !cancelled && setCrew([]));
    return () => {
      cancelled = true;
    };
  }, [matchKey, reload]);

  if (crew === null) return <span className="muted" style={{ fontSize: "0.72rem" }}>Reading the crew list...</span>;
  if (crew.length === 0) {
    return (
      <span className="muted" style={{ fontSize: "0.72rem" }}>
        Nobody is recorded on this match.
      </span>
    );
  }

  return (
    <div
      className="stack"
      style={{
        gap: "0.2rem",
        marginLeft: "0.8rem",
        paddingLeft: "0.6rem",
        borderLeft: "2px solid var(--panel-border)",
      }}
    >
      {crew.map((c) => (
        <div key={c.id} className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.74rem" }}>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ color: teamHex(c.team) }}>{teamName(c.team)}</span>{" "}
            <strong>{c.nickname}</strong>
            {!c.user_id && (
              <span className="badge" title="Not signed in - recorded by nickname only">
                guest
              </span>
            )}
            <span className="muted">
              {" "}
              · {c.shots} shots · {c.hits} hits · {c.sunk} sunk · {c.draw ? "draw" : c.won ? "won" : "lost"}
            </span>
          </span>
          <button
            className="danger"
            disabled={busy}
            style={{ fontSize: "0.7rem", padding: "0.15rem 0.45rem", flex: "none" }}
            title={`Remove ${c.nickname} from this match's records, leaving the match itself intact`}
            onClick={() => {
              if (!window.confirm(`Strike ${c.nickname} from this match? Their career row, shots and recap line go with it.`)) return;
              onRemove(c.nickname);
            }}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

/** Match clock, matching how the record book prints its timings. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const RESULT_COLOR: Record<string, string> = {
  sunk: "var(--sunk)",
  hit: "var(--hit)",
};

/**
 * Seconds from a time typed into the shot log, or null if it isn't one.
 *
 * Two forms, because an admin correcting a shot is reading a clock off a VOD and shouldn't have to
 * convert: "M:SS" (or "H:MM:SS") as the match displays it, or a bare count of seconds. Empty and
 * nonsense both come back null so the caller can refuse them together.
 */
function parseShotTime(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  if (!/^\d+(:[0-5]?\d){1,2}$/.test(t)) return null;
  return durationSeconds(t);
}

/**
 * Every shot in one archived match, each with a way to unmake it or move it.
 *
 * Listed in fired order with the gap since that player's PREVIOUS shot alongside, because the
 * record this exists to fix is made of exactly that number - the quickest back-to-back pair. A
 * mismarked square shows up here as an impossibly short gap, and the two rows that produced the
 * record are the one showing the gap and the one above it with the same name.
 *
 * Which of the two tools to reach for: delete if the square was never killed, retime if it was but
 * the mark landed at the wrong moment. The second is the commoner mistake and the milder fix - it
 * leaves the kill in the Almanac and the player's totals alone.
 */
function MatchShots({
  matchKey,
  duration,
  busy,
  onDelete,
  onRetime,
  reload,
}: {
  matchKey: string;
  /** The match's archived length, used only to question a time that falls outside it. */
  duration: string | null;
  busy: boolean;
  onDelete: (shot: MatchShot) => void;
  onRetime: (shot: MatchShot, seconds: number) => void;
  reload: number;
}) {
  const [shots, setShots] = useState<MatchShot[] | null>(null);
  /** The row being retimed, and what's been typed into it so far. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    listMatchShots(matchKey)
      .then((rows) => !cancelled && setShots(rows))
      .catch(() => !cancelled && setShots([]));
    return () => {
      cancelled = true;
    };
  }, [matchKey, reload]);

  // A reload means the list underneath has changed, so an open editor is pointing at stale numbers.
  useEffect(() => {
    setEditing(null);
  }, [matchKey, reload]);

  if (shots === null) return <span className="muted" style={{ fontSize: "0.72rem" }}>Reading the shot log...</span>;
  if (shots.length === 0) {
    return <span className="muted" style={{ fontSize: "0.72rem" }}>No shots recorded on this match.</span>;
  }

  // Walked in fired order, so each row knows what the same player did last. Keyed by name and team
  // for the same reason the archive is: two crews can field the same nickname.
  const previous = new Map<string, number>();
  const gaps = shots.map((s) => {
    if (s.match_seconds === null) return null;
    const id = `${s.nickname}|${s.team}`;
    const last = previous.get(id);
    previous.set(id, s.match_seconds);
    return last === undefined ? null : s.match_seconds - last;
  });

  const matchLength = durationSeconds(duration);

  function submitRetime(s: MatchShot) {
    const seconds = parseShotTime(draft);
    if (seconds === null) {
      window.alert(`"${draft.trim()}" isn't a time. Give it as M:SS, or as a plain number of seconds.`);
      return;
    }
    // The archived duration is the only outside check available on a hand-typed time, and it's a
    // soft one: a match whose start marker never landed has no duration at all, and the admin may
    // be correcting a shot precisely because the recorded clock is wrong.
    if (matchLength !== null && seconds > matchLength) {
      if (!window.confirm(`${clock(seconds)} is after this match ended (${duration}). Set it anyway?`)) return;
    }
    if (seconds === s.match_seconds) {
      setEditing(null);
      return;
    }
    setEditing(null);
    onRetime(s, seconds);
  }

  return (
    <div
      className="stack"
      style={{
        gap: "0.15rem",
        marginLeft: "0.8rem",
        paddingLeft: "0.6rem",
        borderLeft: "2px solid var(--panel-border)",
      }}
    >
      {shots.map((s, i) => (
        <div key={s.id} className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.74rem" }}>
          <span style={{ minWidth: 0, flex: 1 }}>
            {editing === s.id ? (
              <input
                autoFocus
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitRetime(s);
                  if (e.key === "Escape") setEditing(null);
                }}
                placeholder="M:SS"
                size={6}
                style={{
                  fontSize: "0.74rem",
                  padding: "0 0.25rem",
                  width: "4.5rem",
                  fontVariantNumeric: "tabular-nums",
                }}
              />
            ) : (
              // The clock is the control: click it to correct it. Nothing else in the row is
              // editable, so a second button beside Delete would only be another thing to misread.
              <button
                disabled={busy}
                title="Correct this shot's time"
                onClick={() => {
                  setDraft(s.match_seconds === null ? "" : clock(s.match_seconds));
                  setEditing(s.id);
                }}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  font: "inherit",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  textDecoration: "underline dotted",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {s.match_seconds === null ? "--:--" : clock(s.match_seconds)}
              </button>
            )}{" "}
            <span style={{ color: teamHex(s.team) }}>{s.nickname}</span>{" "}
            <strong>{s.challenge_name ?? `square ${s.cell_index}`}</strong>{" "}
            <span style={{ color: RESULT_COLOR[s.result] ?? "var(--text-dim)" }}>{s.result}</span>
            {gaps[i] !== null && (
              <span className="muted" title="Gap since this player's previous shot">
                {" "}
                · +{clock(gaps[i]!)}
              </span>
            )}
          </span>
          {/* While a time is being edited the row commits or abandons that edit and nothing else -
              Delete is out of reach until it's settled, so a misaimed click can't destroy the row
              somebody was in the middle of correcting. */}
          {editing === s.id ? (
            <span className="row" style={{ gap: "0.3rem", flex: "none" }}>
              <button
                disabled={busy}
                style={{ fontSize: "0.7rem", padding: "0.15rem 0.45rem", flex: "none" }}
                onClick={() => submitRetime(s)}
              >
                Save
              </button>
              <button
                disabled={busy}
                style={{ fontSize: "0.7rem", padding: "0.15rem 0.45rem", flex: "none" }}
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
            </span>
          ) : (
          <button
            className="danger"
            disabled={busy}
            style={{ fontSize: "0.7rem", padding: "0.15rem 0.45rem", flex: "none" }}
            title="Delete this one shot and take it back out of the totals"
            onClick={() => {
              const square = s.challenge_name ?? `square ${s.cell_index}`;
              // The sinking caveat is only raised when it applies: the archive never recorded whose
              // ship went down, so the defending fleet's loss count can't be walked back with it.
              const caveat =
                s.result === "sunk"
                  ? "\n\nThis shot sank a ship. The defending fleet's loss count can't be adjusted automatically - the archive doesn't record whose ship it was."
                  : "";
              if (!window.confirm(`Delete ${s.nickname}'s shot on ${square}? Their shot, hit and sink totals come down with it.${caveat}`)) return;
              onDelete(s);
            }}
          >
            Delete
          </button>
          )}
        </div>
      ))}
      <span className="muted" style={{ fontSize: "0.7rem" }}>
        One row is one square somebody marked. Deleting it removes it from the timing and streak
        records and from the Almanac, and walks back that player's shot, hit and sink totals. Click a
        time to correct a mark that landed at the wrong moment - that keeps the kill and only moves
        it, which is usually the fix you want.
      </span>
    </div>
  );
}
