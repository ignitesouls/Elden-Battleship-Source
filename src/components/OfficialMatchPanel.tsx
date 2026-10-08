import { useEffect, useState } from "react";
import {
  confirmOfficialTeam,
  fetchLiveEvents,
  fetchOfficialMatch,
  linkOfficialRoom,
  unlinkOfficialRoom,
  type OfficialMatchInfo,
} from "../lib/tournament/api";
import { isSupabaseConfigured } from "../lib/supabase";
import { useT } from "../lib/language";
import type { Room } from "../types/battleship";
import { OfficialMatchLine } from "./event/OfficialMatchLine";
import "./Tournament.css";

interface Props {
  room: Room;
  isHost: boolean;
  onError: (message: string | null) => void;
}

/**
 * The lobby's "official match" control.
 *
 * It does not exist for most people, most of the time. The way to MAKE a room official only appears
 * while a tournament is running, and only to the host - so on an ordinary day the lobby is exactly what
 * it always was. Once a room is official, everyone in it sees what it is: which match, and whether each
 * team has entered its entry code yet.
 *
 * A room is official when its host enters their team's entry code, and the match cannot start until the
 * other team has entered theirs from inside the room. Nothing here decides any of that: the database
 * checks the codes, counts wrong guesses, and refuses to let a room start, seat the wrong players or
 * change its settings while it is official. This panel is the way in, not the lock.
 */
export function OfficialMatchPanel({ room, isHost, onError }: Props) {
  const t = useT();
  const linked = !!room.tournament_match_id;
  const [events, setEvents] = useState<Array<{ id: string; name: string }>>([]);
  const [eventId, setEventId] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [info, setInfo] = useState<OfficialMatchInfo | null>(null);

  // Is a tournament running at all? Asked once, and only by a host with an ordinary room: nobody else
  // can act on the answer, so nobody else needs to ask.
  useEffect(() => {
    if (!isSupabaseConfigured || linked || !isHost || room.status !== "lobby") return;
    let cancelled = false;
    fetchLiveEvents()
      .then((rows) => {
        if (cancelled) return;
        setEvents(rows);
        setEventId((current) => current || rows[0]?.id || "");
      })
      .catch(() => undefined); // best effort: a lobby must never fail to load over an optional control
    return () => {
      cancelled = true;
    };
  }, [linked, isHost, room.status]);

  // Who is playing whom, once the room is official.
  useEffect(() => {
    if (!room.tournament_match_id) {
      setInfo(null);
      return;
    }
    let cancelled = false;
    fetchOfficialMatch(room.tournament_match_id)
      .then((m) => !cancelled && setInfo(m))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [room.tournament_match_id]);

  async function run(action: () => Promise<{ ok: boolean; error?: string }>, done?: () => void) {
    setBusy(true);
    setMessage(null);
    onError(null);
    try {
      const answer = await action();
      if (!answer.ok) setMessage(answer.error ?? t("That didn't work.", "Ça n'a pas fonctionné."));
      else done?.();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // -- an ordinary room ---------------------------------------------------------------------------------
  if (!linked) {
    if (!isHost || room.status !== "lobby" || events.length === 0) return null;
    return (
      <div className="panel stack" style={{ gap: "0.6rem", borderColor: "rgba(217, 164, 65, 0.55)" }}>
        <strong>{t("Official tournament match", "Match officiel de tournoi")}</strong>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {t(
            "Playing a bracket match? Enter your team's entry code and this room plays it. The other team confirms with theirs, and the result goes straight into the bracket.",
            "Vous jouez un match de tableau ? Saisissez le code d'entrée de votre équipe et cette partie le jouera. L'autre équipe confirme avec le sien, et le résultat va directement dans le tableau.",
          )}
        </span>
        <div className="row">
          {events.length > 1 && (
            <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.name}</option>
              ))}
            </select>
          )}
          {events.length === 1 && <span className="muted">{events[0].name}</span>}
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={8}
            placeholder={t("Entry code", "Code d'entrée")}
            style={{ width: "9rem", textTransform: "uppercase", letterSpacing: "0.15em" }}
            aria-label={t("Your team's entry code", "Le code d'entrée de votre équipe")}
          />
          <button className="primary" disabled={busy || code.trim().length < 4 || !eventId} onClick={() => void run(() => linkOfficialRoom(room.id, eventId, code), () => setCode(""))}>
            {t("Make this an official match", "Faire de ceci un match officiel")}
          </button>
        </div>
        {message && <span className="error-text">{message}</span>}
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          {t("Once official, the room takes the tournament's settings, only the two teams' players can take a seat, and it can't be a practice match.", "Une fois officielle, la partie adopte les réglages du tournoi, seuls les joueurs des deux équipes peuvent prendre une place, et elle ne peut pas être un entraînement.")}
        </span>
      </div>
    );
  }

  // -- an official room -----------------------------------------------------------------------------------
  const aDone = !!room.official_a_confirmed;
  const bDone = !!room.official_b_confirmed;
  const both = aDone && bDone;
  const teamA = info?.teamA ?? "…";
  const teamB = info?.teamB ?? "…";

  return (
    <div className="panel stack event-banner event-banner--live" style={{ gap: "0.6rem" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong style={{ letterSpacing: "0.08em" }}>{t("OFFICIAL MATCH", "MATCH OFFICIEL")}</strong>
        {info && <span className="muted">{info.eventName}</span>}
      </div>

      <div className="row" style={{ justifyContent: "center", gap: "1rem", fontSize: "1.05rem" }}>
        <span>{teamA} {aDone ? "✓" : ""}</span>
        <span className="muted">{t("vs", "contre")}</span>
        <span>{teamB} {bDone ? "✓" : ""}</span>
      </div>

      {info && info.bestOf > 1 && (
        <span className="muted" style={{ textAlign: "center" }}>
          {t(`Best of ${info.bestOf} - the series stands ${info.scoreA}-${info.scoreB}`, `Au meilleur de ${info.bestOf} - la série est à ${info.scoreA}-${info.scoreB}`)}
        </span>
      )}

      <OfficialMatchLine info={info} />

      {both ? (
        <span className="muted" style={{ textAlign: "center" }}>
          {t("Both teams are confirmed. Take your seats - only players on the two rosters can - and start when you are ready.", "Les deux équipes sont confirmées. Prenez place - seuls les joueurs des deux effectifs le peuvent - et lancez quand vous êtes prêts.")}
        </span>
      ) : (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <span>
            {t(
              `Waiting for ${aDone ? teamB : teamA} to confirm. Someone from that team - their captain - enters THEIR entry code here:`,
              `En attente de la confirmation de ${aDone ? teamB : teamA}. Quelqu'un de cette équipe - son capitaine - saisit SON code d'entrée ici :`,
            )}
          </span>
          <div className="row">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={8}
              placeholder={t("Entry code", "Code d'entrée")}
              style={{ width: "9rem", textTransform: "uppercase", letterSpacing: "0.15em" }}
              aria-label={t("The other team's entry code", "Le code d'entrée de l'autre équipe")}
            />
            <button className="primary" disabled={busy || code.trim().length < 4} onClick={() => void run(() => confirmOfficialTeam(room.id, code), () => setCode(""))}>
              {t("Confirm", "Confirmer")}
            </button>
          </div>
        </div>
      )}
      {message && <span className="error-text">{message}</span>}

      <span className="muted" style={{ fontSize: "0.72rem" }}>
        {t("The tournament's settings are fixed for this match, and it counts toward the bracket.", "Les réglages du tournoi sont figés pour ce match, et il compte pour le tableau.")}
      </span>

      {isHost && room.status === "lobby" && (
        <div>
          <button disabled={busy} onClick={() => void run(() => unlinkOfficialRoom(room.id))}>
            {t("Make this an ordinary room again", "Refaire de ceci une partie ordinaire")}
          </button>
        </div>
      )}
    </div>
  );
}
