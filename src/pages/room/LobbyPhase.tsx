import { useState } from "react";
import { useT } from "../../lib/language";
import { beginPlacementPhase, handOverCaptaincy, kickPlayer, setTeamName, rerollSeed } from "../../lib/rooms";
import { HostTakeover } from "../../components/HostTakeover";
import { OverlayLinkBox } from "../../components/OverlayLinkBox";
import { LeaveMatchButton } from "../../components/LeaveMatchButton";
import { MatchSettings } from "../../components/MatchSettings";
import { OfficialMatchPanel } from "../../components/OfficialMatchPanel";
import { TeamPicker } from "../../components/TeamPicker";
import { FleetDraw } from "../../components/FleetDraw";
import { BrandMark } from "../../components/BrandMark";
import { activeTeams, captainOf } from "../../lib/battleshipLogic";
import { formatRoomCode } from "../../lib/roomCode";
import { TEAM_COLORS, teamName, customTeamName, defaultTeamName } from "../../lib/teamColors";
import type { Room, Player } from "../../types/battleship";
import { SiteFooter } from "../../components/SiteFooter";

interface Props {
  room: Room;
  players: Player[];
  myPlayer: Player;
  onlinePlayerIds: string[];
}

export function LobbyPhase({ room, players, myPlayer, onlinePlayerIds }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedSpectate, setCopiedSpectate] = useState(false);
  const [copiedSeed, setCopiedSeed] = useState(false);
  /**
   * The host opens the draw; it then appears for the whole room, because the
   * broadcast that carries a draw also opens it for anyone who has this lobby
   * on screen. See FleetDraw.
   */
  const [drawOpen, setDrawOpen] = useState(false);

  async function handleReroll() {
    setBusy(true);
    setError(null);
    try {
      await rerollSeed(room.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Still needed for the live/away dot beside each name. The takeover's own copy of this moved into
  // HostTakeover, which needs it on the match screens too.
  const online = new Set(onlinePlayerIds);

  const spectators = players.filter((p) => p.team === null);
  // Only teams that actually have players get a roster card - previously a "next free slot"
  // placeholder rendered as a phantom empty team. Every color is still selectable, from
  // TeamPicker, which owns the switching itself.
  const usedTeams = activeTeams(players);

  // An official match cannot start until both teams have entered their entry codes. The database
  // refuses it too (see guard_official_room); this is the button saying so before it is pressed.
  const awaitingCodes =
    !!room.tournament_match_id && !(room.official_a_confirmed && room.official_b_confirmed);
  const canStart = usedTeams.length >= 2 && !awaitingCodes;

  async function handleStart() {
    setBusy(true);
    setError(null);
    try {
      await beginPlacementPhase(room);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function copyLink() {
    navigator.clipboard?.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function copySpectateLink() {
    navigator.clipboard?.writeText(`${window.location.href}?spectate=1`);
    setCopiedSpectate(true);
    setTimeout(() => setCopiedSpectate(false), 1500);
  }

  /** Live/away dot next to a player's name. */
  function PresenceDot({ id }: { id: string }) {
    const isOn = online.has(id);
    return (
      <span
        aria-label={isOn ? t("online", "en ligne") : t("away", "absent")}
        title={isOn ? t("Online", "En ligne") : t("Away - tab closed or disconnected", "Absent - onglet fermé ou déconnecté")}
        style={{
          display: "inline-block",
          width: "0.5rem",
          height: "0.5rem",
          borderRadius: "50%",
          marginRight: "0.35rem",
          flex: "none",
          background: isOn ? "var(--accent)" : "transparent",
          border: isOn ? "none" : "1px solid var(--text-dim)",
        }}
      />
    );
  }

  /**
   * Host-only inline rename for one team. Submitting an empty field clears the override and the
   * team drops back to its color name - which is also the only way to undo a rename, hence the
   * placeholder showing that default rather than repeating the current custom name.
   */
  function TeamNameField({ roomId, team, colorHex }: { roomId: string; team: number; colorHex: string }) {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState("");
    const [saving, setSaving] = useState(false);

    async function save() {
      setSaving(true);
      setError(null);
      try {
        await setTeamName(roomId, team, value);
        setEditing(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    }

    if (!editing) {
      return (
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: "0.4rem" }}>
          <h3 style={{ color: colorHex, margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>{teamName(team)}</h3>
          <button
            onClick={() => {
              setValue(customTeamName(team) ?? "");
              setEditing(true);
            }}
            style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem", flex: "none" }}
            title={t("Give this team a name of its own", "Donner un nom à cette équipe")}
          >
            {t("Rename", "Renommer")}
          </button>
        </div>
      );
    }

    return (
      <form
        className="row"
        style={{ gap: "0.3rem" }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={24}
          placeholder={defaultTeamName(team)}
          style={{ flex: 1, minWidth: 0, fontSize: "0.8rem" }}
        />
        <button type="submit" disabled={saving} style={{ fontSize: "0.7rem", flex: "none" }}>
          {t("Save", "Enregistrer")}
        </button>
        <button type="button" onClick={() => setEditing(false)} style={{ fontSize: "0.7rem", flex: "none" }}>
          {t("Cancel", "Annuler")}
        </button>
      </form>
    );
  }

  async function handleKick(playerId: string) {
    setBusy(true);
    setError(null);
    try {
      await kickPlayer(playerId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Passes command of my fleet to a crewmate. Offered only in the lobby: once ships are going down
   * the captain is mid-layout, and the database refuses it there anyway (see the captain_handoff
   * migration).
   */
  async function handleHandOver(playerId: string) {
    setBusy(true);
    setError(null);
    try {
      await handOverCaptaincy(playerId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ width: "min(760px, 100%)" }}>
      {/* The lobby is the longest a screen sits still on stream - it's what's up while players
          trickle in and the host waits to start - so it's worth the vertical space here that it
          wouldn't be worth on the placement or battle screens, where every row costs board size.
          Centres itself: `margin: 0 auto` from .brand-mark applies to a flex item too. */}
      <BrandMark width="11rem" />

      <div className="panel row" style={{ justifyContent: "space-between" }}>
        <div>
          <div className="muted">{t("Room code", "Code de la partie")}</div>
          <div
            className="display"
            style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "0.09em", color: "var(--accent)" }}
          >
            {formatRoomCode(room.code)}
          </div>

          {/* Everyone in the room feeds this same number into the randomizer mod, so it has to be
              read off one shared place - hence directly under the code, before anyone scrolls. */}
          <div className="row" style={{ gap: "0.4rem", alignItems: "baseline", marginTop: "0.35rem" }}>
            <span className="muted" style={{ fontSize: "0.75rem" }}>{t("Seed:", "Graine :")}</span>
            <code style={{ fontSize: "0.95rem", letterSpacing: "0.06em", color: "var(--text)" }}>
              {room.seed ?? "-"}
            </code>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(room.seed ?? "");
                setCopiedSeed(true);
                setTimeout(() => setCopiedSeed(false), 1500);
              }}
              disabled={!room.seed}
              style={{ fontSize: "0.68rem", padding: "0.1rem 0.4rem" }}
            >
              {copiedSeed ? t("Copied", "Copié") : t("Copy", "Copier")}
            </button>
            {myPlayer.is_host && (
              <button
                disabled={busy}
                onClick={() => void handleReroll()}
                title={t("Roll a new seed. Everyone must set their game up against the new number.", "Tirer une nouvelle graine. Tout le monde doit reconfigurer son jeu avec le nouveau nombre.")}
                style={{ fontSize: "0.68rem", padding: "0.1rem 0.4rem" }}
              >
                {room.seed ? t("Reroll", "Retirer") : t("Generate", "Générer")}
              </button>
            )}
          </div>
        </div>
        <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {/* The lobby is where a streamer sets their scene up, before there is anything to watch -
              so the fleet list here is the one that decides which board they can point a source at. */}
          <OverlayLinkBox
            roomCode={room.code}
            team={myPlayer.team}
            rejoinCode={myPlayer.rejoin_code}
            teams={usedTeams}
          />
          <button onClick={copySpectateLink} title={t("Link that joins straight into spectator mode", "Lien qui rejoint directement en mode spectateur")}>
            {copiedSpectate ? t("Copied!", "Copié !") : t("Spectator link", "Lien spectateur")}
          </button>
          <button onClick={copyLink}>{copied ? t("Copied!", "Copié !") : t("Copy invite link", "Copier le lien d'invitation")}</button>
        </div>
      </div>

      {/* Now shared with the match screens - see HostTakeover for why it can't live only here. */}
      <HostTakeover players={players} onlinePlayerIds={onlinePlayerIds} myPlayerId={myPlayer.id} />

      {/* Above the team picker: what you're playing decides which fleet you want to be on, and
          the host usually sets it before anyone picks. */}
      <MatchSettings room={room} isHost={myPlayer.is_host} onError={setError} />

      {/* Exists only while a tournament is running (and, to make a room official, only for the host).
          On an ordinary day this renders nothing at all. */}
      <OfficialMatchPanel room={room} isHost={myPlayer.is_host} onError={setError} />

      <TeamPicker
        room={room}
        playerId={myPlayer.id}
        currentTeam={myPlayer.team}
        players={players}
        onError={setError}
      />

      <div className="row" style={{ alignItems: "stretch" }}>
        {usedTeams.map((team) => {
          const color = TEAM_COLORS[team];
          const teamPlayers = players.filter((p) => p.team === team);
          const captain = captainOf(players, team);
          const iCaptainThis = captain?.id === myPlayer.id;
          return (
            <div key={team} className="panel stack" style={{ flex: 1, minWidth: 180 }}>
              {/* The fleet's own captain renames it; the host can rename any, since they run the
                  room. Everyone else just reads it. */}
              {myPlayer.is_host || iCaptainThis ? (
                <TeamNameField roomId={room.id} team={team} colorHex={color.hex} />
              ) : (
                <h3 style={{ color: color.hex, margin: 0 }}>{teamName(team)}</h3>
              )}
              <div className="stack" style={{ gap: "0.3rem" }}>
                {teamPlayers.length === 0 && <span className="muted">{t("Empty", "Vide")}</span>}
                {teamPlayers.map((p) => {
                  // Presence hasn't reported yet while the list is empty, which must not read as
                  // "everybody is away" - the same guard HostTakeover makes.
                  const away = onlinePlayerIds.length > 0 && !online.has(p.id);
                  return (
                    <div key={p.id} className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
                      <span style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
                        <PresenceDot id={p.id} />
                        {p.nickname} {p.is_host && <span className="badge">{t("host", "hôte")}</span>}
                        {captain?.id === p.id && <span className="badge">{t("captain", "capitaine")}</span>}
                        {p.id === myPlayer.id && <span className="badge">{t("you", "vous")}</span>}
                      </span>
                      <div className="row" style={{ gap: "0.3rem", flex: "none" }}>
                        {/* Command passes downwards only - a captain hands it over, nobody takes it.
                            Which is why an absent crewmate is refused rather than merely warned
                            about: only a captain can hand it on, so handing it to a closed tab
                            leaves the fleet with nobody able to place its ships. */}
                        {iCaptainThis && p.id !== myPlayer.id && (
                          <button
                            disabled={busy || away}
                            onClick={() => void handleHandOver(p.id)}
                            style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }}
                            title={
                              away
                                ? t(
                                    `${p.nickname} is away, so command would be stuck with them`,
                                    `${p.nickname} est absent, la commande resterait bloquée chez lui`
                                  )
                                : t(
                                    `Hand command of this fleet to ${p.nickname}, who then places its ships`,
                                    `Confier le commandement de cette flotte à ${p.nickname}, qui placera ensuite ses navires`
                                  )
                            }
                          >
                            {t("Make captain", "Nommer capitaine")}
                          </button>
                        )}
                        {myPlayer.is_host && p.id !== myPlayer.id && (
                          <button disabled={busy} onClick={() => handleKick(p.id)} title={t("Kick", "Exclure")}>
                            {t("Kick", "Exclure")}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {spectators.length > 0 && (
        <div className="panel stack" style={{ gap: "0.3rem" }}>
          <span className="muted">{t("Spectating:", "Spectateurs :")}</span>
          {spectators.map((p) => (
            <div key={p.id} className="row" style={{ justifyContent: "space-between" }}>
              <span style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
                <PresenceDot id={p.id} />
                {p.nickname} {p.is_host && <span className="badge">{t("host", "hôte")}</span>}
                {p.id === myPlayer.id && <span className="badge">{t("you", "vous")}</span>}
              </span>
              {myPlayer.is_host && p.id !== myPlayer.id && (
                <button disabled={busy} onClick={() => handleKick(p.id)} title={t("Kick", "Exclure")}>
                  {t("Kick", "Exclure")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      {/**
       * The draw is opened by the host and appears for everybody, so the
       * button is host-only but the component is mounted for the whole room -
       * see FleetDraw for how a draw reaches the people who did not press it.
       */}
      {myPlayer.is_host && (
        <button className="secondary" onClick={() => setDrawOpen(true)} disabled={players.length < 2}>
          {t("Draw teams at sea", "Tirer les équipes au sort")}
        </button>
      )}

      <FleetDraw
        roomId={room.id}
        players={players}
        isHost={myPlayer.is_host}
        open={drawOpen}
        onOpenChange={setDrawOpen}
      />

      {myPlayer.is_host ? (
        <button className="primary" disabled={busy || !canStart} onClick={handleStart}>
          {canStart
            ? t("Start ship placement", "Commencer le placement des navires")
            : awaitingCodes
              ? t("Waiting for both teams to enter their entry codes", "En attente des codes d'entrée des deux équipes")
              : t("Need at least 2 fleets with players", "Il faut au moins 2 flottes avec des joueurs")}
        </button>
      ) : (
        <div className="muted" style={{ textAlign: "center" }}>
          {t("Waiting for the host to start the match...", "En attente que l'hôte démarre le match...")}
        </div>
      )}

      {/* The rejoin code used to sit here. It's moved to the match screen (see MatchInfoBox): the
          lobby is a screen you pass through in seconds, so a code you only notice here is a code
          you haven't written down by the time you need it. */}

      <LeaveMatchButton playerId={myPlayer.id} roomCode={room.code} inMatch={false} label={t("Leave room", "Quitter la partie")} />

      <SiteFooter />
    </div>
  );
}
