import { useEffect, useState } from "react";
import { serverNow } from "../lib/serverTime";
import {
  useAdminStatus,
  listAdmins,
  grantAdmin,
  revokeAdmin,
  deleteMatchRecord,
  setMatchVoided,
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
import { useT } from "../lib/language";
import type { MatchReportRow } from "../types/battleship";

interface Props {
  /** The page of matches that has been loaded, newest first - not necessarily all of them. */
  matches: MatchReportRow[];
  /** How many matches exist in total, loaded or not. Null while that count is still in flight. */
  total?: number | null;
  /** Loads the next page. Absent once everything is loaded, which is what hides the button. */
  onShowMore?: () => void;
  loadingMore?: boolean;
  /**
   * Bumped by the page whenever something was actually changed. The room list, the grant list and
   * the orphan count hang off this rather than off `matches`, because `matches` also changes when
   * a page is merely loaded - and countOrphans reads three whole tables to answer, which is not a
   * thing to redo because somebody asked to see twenty-five more rows.
   */
  revision?: number;
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
export function AdminPanel({ matches, total = null, onShowMore, loadingMore, revision = 0, onChanged }: Props) {
  const t = useT();
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
  }, [isAdmin, revision]);

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

  /** What the wipe would actually destroy: the whole archive, not the page being shown. */
  const wipeCount = total !== null ? total : matches.length;

  return (
    <div className="panel stack" style={{ gap: "0.7rem", borderColor: "var(--danger)", width: "100%" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0, color: "var(--danger)" }}>{t("Admin", "Admin")}</h3>
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          {isOwner ? t("Owner", "Propriétaire") : t("Administrator", "Administrateur")}
        </span>
      </div>

      {note && <div className="muted" style={{ fontSize: "0.78rem" }}>{note}</div>}

      {/* -- Records -- */}
      <div className="stack" style={{ gap: "0.35rem" }}>
        {/* Both numbers, when they differ: the second is what exists, the first is what the buttons
            below can currently reach. One number alone would read as the whole archive. */}
        <strong style={{ fontSize: "0.82rem" }}>
          {t("Archived matches", "Parties archivées")} (
          {total !== null && total > matches.length
            ? t(`${matches.length} of ${total}`, `${matches.length} sur ${total}`)
            : matches.length}
          )
        </strong>
        {matches.length === 0 && (
          <span className="muted" style={{ fontSize: "0.78rem" }}>{t("Nothing on record.", "Rien à afficher.")}</span>
        )}
        {matches.map((m) => (
          <div key={m.id} className="stack" style={{ gap: "0.25rem" }}>
            <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.78rem" }}>
              <span style={{ minWidth: 0, flex: 1 }}>
                <strong style={{ color: m.winner_team !== null ? teamHex(m.winner_team) : "var(--text-dim)" }}>
                  {m.winner_team !== null ? teamName(m.winner_team) : t("Draw", "Match nul")}
                </strong>
                <span className="muted">
                  {" "}
                  · {formatRoomCode(m.room_code)} · {m.duration ?? "--:--"} · {m.total_shots} {t("shots", "tirs")} ·{" "}
                  {new Date(m.finished_at).toLocaleString()}
                </span>
                {/* The list is otherwise unchanged by voiding, so without this the button below is
                    the only thing on the page that knows, and it reads as an offer rather than a
                    state. */}
                {m.practice ? (
                  <strong style={{ color: "var(--hit)" }}> · {t("PRACTICE", "ENTRAÎNEMENT")}</strong>
                ) : (
                  m.voided && <strong style={{ color: "var(--danger)" }}> · {t("VOIDED", "ANNULÉ")}</strong>
                )}
              </span>
              {/* Opens the crew list for this match. Deleting a whole game because one name on it
                  shouldn't be there wipes everybody else's record of it too, so the finer tool sits
                  right beside the blunt one. */}
              <button
                disabled={busy}
                style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
                onClick={() => setOpenMatch((k) => (k === m.match_key ? null : m.match_key))}
              >
                {openMatch === m.match_key ? t("Hide crew", "Masquer l'équipage") : t("Crew", "Équipage")}
              </button>
              {/* Finer still than the crew list: one square somebody marked. A mismarked square
                  can hold a timing record outright, and this is the only thing that can take it
                  back without deleting everything either side of it. */}
              <button
                disabled={busy}
                style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
                onClick={() => setOpenShots((k) => (k === m.match_key ? null : m.match_key))}
              >
                {openShots === m.match_key ? t("Hide shots", "Masquer les tirs") : t("Shots", "Tirs")}
              </button>
              {/* Sits between "Crew" and "Delete" in force, and is the only one of the three that
                  can be taken back. Every row stays exactly where it is; the site stops counting
                  them. That is the right tool for a match whose shots were real but whose clock is
                  not - deleting it would throw away true results to be rid of false ones. */}
              <button
                // A practice match cannot be restored, and the database will refuse it (see
                // guard_practice_record). Disabled rather than left to raise: the point of declaring
                // a match practice BEFORE it is played is that the declaration cannot be revised
                // once the result is in, and a button that offers and then fails says the opposite.
                disabled={busy || m.practice}
                title={
                  m.practice
                    ? t(
                        "Declared a practice match before it was played. That can't be taken back.",
                        "Déclarée partie d'entraînement avant d'être jouée. Impossible à annuler."
                      )
                    : undefined
                }
                style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none", opacity: m.practice ? 0.4 : undefined }}
                onClick={() =>
                  void run(async () => {
                    await setMatchVoided(m.match_key, !m.voided);
                    onChanged();
                    const where = formatRoomCode(m.room_code);
                    return m.voided
                      ? t(`${where} counts again.`, `${where} compte à nouveau.`)
                      : t(
                          `Voided ${where} - it stays in the archive and counts for nothing.`,
                          `${where} annulée - elle reste dans les archives mais ne compte plus.`
                        );
                  })
                }
              >
                {m.voided ? t("Restore", "Restaurer") : t("Void", "Annuler")}
              </button>
              <button
                className="danger"
                disabled={busy}
                style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
                onClick={() =>
                  void run(async () => {
                    await deleteMatchRecord(m.match_key);
                    onChanged();
                    return t(`Deleted ${formatRoomCode(m.room_code)}.`, `${formatRoomCode(m.room_code)} supprimée.`);
                  })
                }
              >
                {t("Delete", "Supprimer")}
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
                    return t(
                      `Struck ${nickname} from ${formatRoomCode(m.room_code)}.`,
                      `${nickname} rayé de ${formatRoomCode(m.room_code)}.`
                    );
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
                    const square = shot.challenge_name ?? t(`square ${shot.cell_index}`, `case ${shot.cell_index}`);
                    return t(
                      `Deleted ${shot.nickname}'s shot on ${square}.`,
                      `Tir de ${shot.nickname} sur ${square} supprimé.`
                    );
                  })
                }
                onRetime={(shot, seconds) =>
                  void run(async () => {
                    await updateMatchShotTime(shot, seconds);
                    setShotReload((n) => n + 1);
                    onChanged();
                    const square = shot.challenge_name ?? t(`square ${shot.cell_index}`, `case ${shot.cell_index}`);
                    const was = shot.match_seconds === null ? "--:--" : clock(shot.match_seconds);
                    return t(
                      `Moved ${shot.nickname}'s shot on ${square} from ${was} to ${clock(seconds)}.`,
                      `Tir de ${shot.nickname} sur ${square} déplacé de ${was} à ${clock(seconds)}.`
                    );
                  })
                }
                reload={shotReload}
              />
            )}
          </div>
        ))}

        {/* Sits inside the list rather than under it, so it reads as the end of these rows and not
            as another record-book control alongside the wipe. */}
        {onShowMore && (
          <button
            disabled={busy || loadingMore}
            style={{ fontSize: "0.72rem", padding: "0.25rem 0.5rem", alignSelf: "center" }}
            onClick={onShowMore}
          >
            {loadingMore
              ? t("Loading...", "Chargement...")
              : total !== null
                ? t(
                    `Show more (${total - matches.length} older)`,
                    `Afficher plus (${total - matches.length} plus anciennes)`
                  )
                : t("Show more", "Afficher plus")}
          </button>
        )}
      </div>

      {/* Orphans: rows in the satellite tables whose parent report is gone. Surfaced separately
          because the list above is built from match_reports, so an orphan is invisible there while
          still counting on the leaderboard, which reads match_participants directly.

          Nearly all of them are NOT debris. prune_stale_rooms() deletes every report older than 30
          days and keeps the stats rows, so most of the archive's matches are "orphans" by this
          count - and clearing them wipes those matches out of every stat for good. The wording says
          so, and the button asks first. A single bad match is voided from the Almanac's Hall of
          Fame instead, which works on swept matches too. */}
      {orphans > 0 && (
        <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", alignItems: "center" }}>
          <span className="muted" style={{ fontSize: "0.76rem", minWidth: 0, flex: 1 }}>
            <strong style={{ color: "var(--hit)" }}>
              {orphans === 1
                ? t(`${orphans} orphaned record row`, `${orphans} ligne orpheline`)
                : t(`${orphans} orphaned record rows`, `${orphans} lignes orphelines`)}
            </strong>{" "}
            - {t(
              "matches older than 30 days, whose recap page has been cleared. They still count in every stat. To strike one match, void it from the Almanac's Hall of Fame.",
              "parties de plus de 30 jours dont le résumé a été effacé. Elles comptent toujours dans toutes les statistiques. Pour retirer une partie, annulez-la depuis le Panthéon de l'almanach."
            )}
          </span>
          <button
            className="danger"
            disabled={busy}
            style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
            onClick={() => {
              if (
                !window.confirm(
                  t(
                    `Delete ${orphans} rows for good? These are real matches older than 30 days. They will disappear from the leaderboard, the Almanac and every record, and there is no undo.`,
                    `Supprimer définitivement ${orphans} lignes ? Ce sont de vraies parties de plus de 30 jours. Elles disparaîtront du classement, de l'almanach et de tous les records, sans retour possible.`
                  )
                )
              )
                return;
              void run(async () => {
              const n = await deleteOrphans();
              setOrphans(await countOrphans().catch(() => 0));
              onChanged();
              return n === 1
                ? t(`Cleared ${n} orphaned record.`, `${n} ligne orpheline effacée.`)
                : t(`Cleared ${n} orphaned records.`, `${n} lignes orphelines effacées.`);
              });
            }}
          >
            {t("Clear orphans", "Effacer les orphelines")}
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
          return t("Downloaded a JSON backup of every record.", "Sauvegarde JSON de tous les enregistrements téléchargée.");
        })}
      >
        {t("Download backup (JSON)", "Télécharger la sauvegarde (JSON)")}
      </button>

      {/* -- Wipe everything --
          Gated behind typing the word rather than a confirm() dialog: this clears every career
          record on the site with no undo and no backup, and a button you can hit by reflex is the
          wrong shape for that. The count in it is the whole archive rather than the loaded page:
          this erases matches that are not on the screen, and saying "25 matches" while wiping two
          hundred would be a lie told at the one moment it matters most. */}
      {(matches.length > 0 || orphans > 0) && (
        <div className="stack" style={{ gap: "0.3rem" }}>
          {/* Offered when there are orphans even with zero matches - that combination is exactly
              the state where the list above looks empty but the leaderboard doesn't. */}
          <span className="muted" style={{ fontSize: "0.72rem" }}>
            {t("Type", "Tapez")} <code>WIPE</code>{" "}
            {wipeCount > 0
              ? t(
                  `to erase every record row (${wipeCount} match${wipeCount === 1 ? "" : "es"}). This cannot be undone.`,
                  `pour effacer chaque ligne d'enregistrement (${wipeCount} partie${wipeCount === 1 ? "" : "s"}). Action irréversible.`
                )
              : t("to erase every record row. This cannot be undone.", "pour effacer chaque ligne d'enregistrement. Action irréversible.")}
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
                  return n === 1
                    ? t(`Erased ${n} match record.`, `${n} enregistrement de partie effacé.`)
                    : t(`Erased ${n} match records.`, `${n} enregistrements de partie effacés.`);
                })
              }
            >
              {t("Erase all records", "Effacer tous les enregistrements")}
            </button>
          </div>
        </div>
      )}

      {/* -- Live rooms -- */}
      <div className="stack" style={{ gap: "0.35rem", borderTop: "1px solid var(--panel-border)", paddingTop: "0.6rem" }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <strong style={{ fontSize: "0.82rem" }}>{t("Live rooms", "Parties en direct")} ({rooms.length}/15)</strong>
          <button
            disabled={busy}
            style={{ fontSize: "0.7rem", padding: "0.2rem 0.5rem" }}
            onClick={() => void run(async () => {
              const n = await pruneRooms();
              setRooms(await listRooms().catch(() => []));
              return n === 1
                ? t(`Pruned ${n} stale room.`, `${n} partie obsolète purgée.`)
                : t(`Pruned ${n} stale rooms.`, `${n} parties obsolètes purgées.`);
            })}
          >
            {t("Prune stale", "Purger les obsolètes")}
          </button>
        </div>
        {rooms.length === 0 && (
          <span className="muted" style={{ fontSize: "0.78rem" }}>{t("No rooms open.", "Aucune partie ouverte.")}</span>
        )}
        {rooms.map((r) => (
          <div key={r.id} className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.78rem" }}>
            <span style={{ minWidth: 0, flex: 1 }}>
              <strong>{formatRoomCode(r.code)}</strong>
              <span className="muted">
                {" "}
                · {r.status} ·{" "}
                {r.players === 1
                  ? t(`${r.players} player`, `${r.players} joueur`)
                  : t(`${r.players} players`, `${r.players} joueurs`)}{" "}
                ·{" "}
                {/* serverNow, not Date.now: created_at is a Postgres timestamp, so a skewed PC
                    clock would otherwise report rooms as older or younger than they are. */}
                {t(
                  `${Math.round((serverNow() - new Date(r.created_at).getTime()) / 60000)}m old`,
                  `${Math.round((serverNow() - new Date(r.created_at).getTime()) / 60000)}m`
                )}
              </span>
            </span>
            <button
              className="danger"
              disabled={busy}
              style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
              onClick={() => void run(async () => {
                await deleteRoom(r.id);
                setRooms(await listRooms().catch(() => []));
                return t(`Deleted room ${formatRoomCode(r.code)}.`, `Partie ${formatRoomCode(r.code)} supprimée.`);
              })}
            >
              {t("Delete", "Supprimer")}
            </button>
          </div>
        ))}
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          {t(
            "Deleting a room removes its players, fleets and attack log with it. Use it on a stuck room that's holding one of the 15 slots.",
            "Supprimer une partie retire aussi ses joueurs, ses flottes et son journal de tirs. À utiliser sur une partie bloquée qui occupe une des 15 places."
          )}
        </span>
      </div>

      {/* -- Admins -- */}
      <div className="stack" style={{ gap: "0.35rem", borderTop: "1px solid var(--panel-border)", paddingTop: "0.6rem" }}>
        <strong style={{ fontSize: "0.82rem" }}>{t("Administrators", "Administrateurs")}</strong>
        {admins.map((a) => (
          <div key={a.user_id} className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.78rem" }}>
            <span>
              {a.display_name ?? a.user_id.slice(0, 8)}
              {a.is_owner && <span className="badge">{t("owner", "propriétaire")}</span>}
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
                    const who = a.display_name ?? t("that account", "ce compte");
                    return t(`Removed ${who}.`, `${who} retiré.`);
                  })
                }
              >
                {t("Revoke", "Révoquer")}
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
            placeholder={t("Twitch display name", "Nom d'affichage Twitch")}
            style={{ flex: 1, minWidth: 0, fontSize: "0.78rem" }}
          />
          <button type="submit" disabled={busy} style={{ fontSize: "0.75rem", flex: "none" }}>
            {t("Make admin", "Nommer administrateur")}
          </button>
        </form>
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          {t(
            "They must have signed in with Twitch here at least once, so the grant attaches to their account rather than to a name.",
            "Ils doivent s'être connectés avec Twitch ici au moins une fois, afin que le droit s'attache à leur compte plutôt qu'à un nom."
          )}
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
  const t = useT();
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

  if (crew === null) {
    return <span className="muted" style={{ fontSize: "0.72rem" }}>{t("Reading the crew list...", "Lecture de la liste de l'équipage...")}</span>;
  }
  if (crew.length === 0) {
    return (
      <span className="muted" style={{ fontSize: "0.72rem" }}>
        {t("Nobody is recorded on this match.", "Personne n'est enregistré sur cette partie.")}
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
              <span className="badge" title={t("Not signed in - recorded by nickname only", "Non connecté - enregistré par surnom uniquement")}>
                {t("guest", "invité")}
              </span>
            )}
            <span className="muted">
              {" "}
              · {c.shots} {t("shots", "tirs")} · {c.hits} {t("hits", "touchés")} · {c.sunk} {t("sunk", "coulés")} ·{" "}
              {c.draw ? t("draw", "nul") : c.won ? t("won", "gagné") : t("lost", "perdu")}
            </span>
          </span>
          <button
            className="danger"
            disabled={busy}
            style={{ fontSize: "0.7rem", padding: "0.15rem 0.45rem", flex: "none" }}
            title={t(
              `Remove ${c.nickname} from this match's records, leaving the match itself intact`,
              `Retirer ${c.nickname} des enregistrements de cette partie, en laissant la partie elle-même intacte`
            )}
            onClick={() => {
              if (
                !window.confirm(
                  t(
                    `Strike ${c.nickname} from this match? Their career row, shots and recap line go with it.`,
                    `Rayer ${c.nickname} de cette partie ? Sa ligne de carrière, ses tirs et sa ligne de récapitulatif partent avec.`
                  )
                )
              )
                return;
              onRemove(c.nickname);
            }}
          >
            {t("Remove", "Retirer")}
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
  const t = useT();
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

  if (shots === null) {
    return <span className="muted" style={{ fontSize: "0.72rem" }}>{t("Reading the shot log...", "Lecture du journal des tirs...")}</span>;
  }
  if (shots.length === 0) {
    return (
      <span className="muted" style={{ fontSize: "0.72rem" }}>
        {t("No shots recorded on this match.", "Aucun tir enregistré sur cette partie.")}
      </span>
    );
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
      window.alert(
        t(
          `"${draft.trim()}" isn't a time. Give it as M:SS, or as a plain number of seconds.`,
          `"${draft.trim()}" n'est pas une durée valide. Indiquez-la sous la forme M:SS, ou en nombre de secondes.`
        )
      );
      return;
    }
    // The archived duration is the only outside check available on a hand-typed time, and it's a
    // soft one: a match whose start marker never landed has no duration at all, and the admin may
    // be correcting a shot precisely because the recorded clock is wrong.
    if (matchLength !== null && seconds > matchLength) {
      if (
        !window.confirm(
          t(
            `${clock(seconds)} is after this match ended (${duration}). Set it anyway?`,
            `${clock(seconds)} est après la fin de cette partie (${duration}). Confirmer quand même ?`
          )
        )
      )
        return;
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
                placeholder={t("M:SS", "M:SS")}
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
                title={t("Correct this shot's time", "Corriger l'heure de ce tir")}
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
            <strong>{s.challenge_name ?? t(`square ${s.cell_index}`, `case ${s.cell_index}`)}</strong>{" "}
            <span style={{ color: RESULT_COLOR[s.result] ?? "var(--text-dim)" }}>
              {s.result === "sunk"
                ? t("sunk", "coulé")
                : s.result === "hit"
                  ? t("hit", "touché")
                  : s.result === "miss"
                    ? t("miss", "manqué")
                    : s.result}
            </span>
            {gaps[i] !== null && (
              <span className="muted" title={t("Gap since this player's previous shot", "Écart depuis le tir précédent de ce joueur")}>
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
                {t("Save", "Enregistrer")}
              </button>
              <button
                disabled={busy}
                style={{ fontSize: "0.7rem", padding: "0.15rem 0.45rem", flex: "none" }}
                onClick={() => setEditing(null)}
              >
                {t("Cancel", "Annuler")}
              </button>
            </span>
          ) : (
          <button
            className="danger"
            disabled={busy}
            style={{ fontSize: "0.7rem", padding: "0.15rem 0.45rem", flex: "none" }}
            title={t("Delete this one shot and take it back out of the totals", "Supprimer ce tir et le retirer des totaux")}
            onClick={() => {
              const square = s.challenge_name ?? t(`square ${s.cell_index}`, `case ${s.cell_index}`);
              // The sinking caveat is only raised when it applies: the archive never recorded whose
              // ship went down, so the defending fleet's loss count can't be walked back with it.
              const caveat =
                s.result === "sunk"
                  ? t(
                      "\n\nThis shot sank a ship. The defending fleet's loss count can't be adjusted automatically, because the archive doesn't record whose ship it was.",
                      "\n\nCe tir a coulé un navire. Le total de pertes de la flotte adverse ne peut pas être ajusté automatiquement, car l'archive n'enregistre pas de quel navire il s'agissait."
                    )
                  : "";
              if (
                !window.confirm(
                  t(
                    `Delete ${s.nickname}'s shot on ${square}? Their shot, hit and sink totals come down with it.${caveat}`,
                    `Supprimer le tir de ${s.nickname} sur ${square} ? Ses totaux de tirs, touchés et coulés en seront réduits d'autant.${caveat}`
                  )
                )
              )
                return;
              onDelete(s);
            }}
          >
            {t("Delete", "Supprimer")}
          </button>
          )}
        </div>
      ))}
      <span className="muted" style={{ fontSize: "0.7rem" }}>
        {t(
          "One row is one square somebody marked. Deleting it takes the square out of the timing and streak records and out of the Almanac, and walks back that player's shot, hit and sink totals. To fix a mistimed mark, click its time instead: that keeps the kill and only moves it.",
          "Une ligne correspond à une case marquée par un joueur. La supprimer retire la case des records de timing et de série ainsi que de l'Almanach, et réduit d'autant les totaux de tirs, touchés et coulés de ce joueur. Pour corriger un horodatage erroné, cliquez plutôt sur son heure : cela conserve le tir et le déplace seulement."
        )}
      </span>
    </div>
  );
}
