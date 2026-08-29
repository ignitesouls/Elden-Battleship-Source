import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { LobbyPhase } from "./room/LobbyPhase";
import { PlacementPhase } from "./room/PlacementPhase";
import { BattlePhase } from "./room/BattlePhase";
import { joinRoom, resetRoomToLobby, redeemRejoinCode, startBattle } from "../lib/rooms";
import { activeTeams } from "../lib/battleshipLogic";
import { setEgressRole } from "../lib/egressMeter";
import { teamName, teamHex } from "../lib/teamColors";
import {
  getLastNickname,
  storeLastNickname,
  getStoredPlayerId,
  setActiveRoom,
  clearActiveRoom,
} from "../lib/playerSession";
import { Link } from "react-router-dom";
import { useAuthProfile, accountName, saveNickname } from "../hooks/useAuthProfile";
import { NICKNAME_MAX } from "../lib/profiles";
import { BoardGrid, type CellVisual, type ShipOverlay } from "../components/BoardGrid";
import { MatchReport } from "../components/MatchReport";
import { sunkCellOrientations, eliminatedTeamsFromAttacks, sunkHullFlags } from "../lib/battleshipLogic";
import { AttackFeed } from "../components/AttackFeed";
import { groupIntoShots } from "../lib/attackFeed";
import { deepWater, deepMarks, type DeepHide } from "../lib/deepWater";
import { TeamBox } from "../components/TeamBox";
import { HostTakeover } from "../components/HostTakeover";
import { formatRoomCode } from "../lib/roomCode";
import { useBattlePhaseName, useBattleClock } from "../hooks/useBattlePhase";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { TeamPicker } from "../components/TeamPicker";
import { SpectateWithCrew } from "../components/SpectateWithCrew";
import { OddsPanel } from "../components/OddsPanel";
import { useVictoryOdds } from "../hooks/useVictoryOdds";
import type { OddsPoint, OddsSnapshot } from "../lib/victoryOdds";
import { useStoredToggle } from "../hooks/useStoredToggle";
import { formatDuration } from "../lib/matchTime";
import { LoadingScreen } from "../components/BrandMark";
import { BoardLegend } from "../components/BoardLegend";
import { useSpectatorCounts, countChips } from "../hooks/useSquareCounts";
import { challengesForRoom, igonAnchor } from "../lib/challenges";
import type { Challenge } from "../lib/challenges";
import { squaresRevealed } from "../lib/overlayReveal";
import { playSfx } from "../lib/sfx";
import { useSpectatorSfx } from "../hooks/useSpectatorSfx";
import { MatchClock } from "../components/MatchClock";
import { EndMatchButton } from "../components/EndMatchButton";
import { PauseBanner, PauseControls } from "../components/PauseControls";
import { LeaveMatchButton } from "../components/LeaveMatchButton";
import { useBoxSize, boardSideFor, boardColumns } from "../hooks/useBoxSize";
import { CanvasPanel } from "../components/CanvasPanel";
import { usePanelLayout } from "../hooks/usePanelLayout";
import {
  defaultSpectatorLayout,
  spectatorPanelIds,
  teamPanelId,
  type SpectatorPanelId,
} from "../lib/spectatorLayout";
import type { PanelBox } from "../lib/panelLayout";
import { cellVisuals } from "../lib/cellVisuals";
import type { Attack, Room as RoomType, Fleet, Player } from "../types/battleship";
import "./Spectator.css";

/** Stable identity for a fleet with nothing sunk yet, so the visuals memo allocates nothing extra. */
const EMPTY_SUNK: ReadonlyMap<number, boolean> = new Map();

export function Room() {
  const { code } = useParams<{ code: string }>();
  const state = useRoom(code);
  const prevStatus = useRef<string | null>(null);
  // The NAME only. This hook sits at the top of the match screen, so anything that changes here
  // re-renders both boards, the log and every roster below it - and the one thing this page wants
  // out of the clock is the horn cue below, which fires on a phase change. Taking the ticking
  // variant here was re-rendering the entire match screen once a second for a number nothing on
  // this page draws. See useBattlePhase.
  const battlePhase = useBattlePhaseName(state.attacks, state.room);
  const prevPhase = useRef<string | null>(null);

  // Horn #1: the battle begins (STARTING countdown opens).
  useEffect(() => {
    if (state.room?.status === "battle" && prevStatus.current !== "battle") {
      playSfx("prepare");
    }
    prevStatus.current = state.room?.status ?? null;
  }, [state.room?.status]);

  // Fanfare or fail sting, once, on the moment the last fleet goes down.
  //
  // Its own ref rather than reusing prevStatus above, which the horn effect overwrites - two effects
  // reading one ref would make this depend on the order React happens to run them in.
  //
  // Gated on having seen a previous status, so opening a link to a match that finished an hour ago
  // is a silent recap. A draw takes the sting: nobody won it. A spectator hears the fanfare, since
  // from the stands the interesting fact is that somebody was left standing.
  const prevStatusForResult = useRef<string | null>(null);
  useEffect(() => {
    const status = state.room?.status ?? null;
    if (status === "finished" && prevStatusForResult.current !== null && prevStatusForResult.current !== "finished") {
      const myTeam = state.myPlayer?.team ?? null;
      const winner = state.room?.winner_team ?? null;
      const lost = winner === null || (myTeam !== null && winner !== myTeam);
      playSfx(lost ? "defeat" : "victory");
    }
    prevStatusForResult.current = status;
  }, [state.room?.status, state.room?.winner_team, state.myPlayer?.team]);

  // Horn #2: preparation is over and the match clock starts counting up. Gated on having seen a
  // previous phase, so loading the page into an already-running match doesn't blast the horn at
  // someone who just arrived.
  useEffect(() => {
    if (battlePhase === "match" && prevPhase.current !== null && prevPhase.current !== "match") {
      playSfx("prepare");
    }
    prevPhase.current = battlePhase;
  }, [battlePhase]);

  // Battle opens the instant every fleet has confirmed its placement.
  //
  // Driven from here rather than from inside PlacementPhase, which is where it used to live: that
  // component only mounts for a player who is ON a fleet, so a host who chose to spectate never ran
  // it and the room sat in placement forever with every fleet ready and nothing able to start. The
  // host is still the one who triggers it (a single writer keeps the start marker unambiguous),
  // they just no longer have to be holding a fleet to do it.
  //
  // startedRef guards against a second request from this client between the write and the status
  // actually flipping; startBattle() itself tolerates a duplicate caller.
  const [hostError, setHostError] = useState<string | null>(null);
  const battleStartedRef = useRef(false);
  useEffect(() => {
    const room = state.room;
    if (!room || room.status !== "placement") {
      battleStartedRef.current = false; // so a rematch in this same room can start again
      return;
    }
    if (!state.myPlayer?.is_host || battleStartedRef.current) return;

    const teams = activeTeams(state.players);
    if (teams.length < 2) return;
    const ready = new Set(state.teamReady.filter((t) => t.ready).map((t) => t.team));
    if (!teams.every((t) => ready.has(t))) return;

    battleStartedRef.current = true;
    startBattle(room.id)
      .then((balance) => {
        // Whatever last stopped the start - most likely a crew that hadn't placed - is over with,
        // or we would not be here. Left standing, that sentence sat under a match already in
        // progress, still naming a fleet that had since put its ships down.
        setHostError(null);
        // Said out loud, to the one person who can do anything about it. An unbalanced board is not
        // an error - the match starts and plays - but it is the match's fairness quietly not
        // happening, and it used to go only to a console line nobody reads. `already_balanced` is
        // this same client having been beaten to it, which is the guard working rather than a fault.
        if (balance.balanced || balance.reason === "already_balanced") return;
        setHostError(
          `This board was NOT balanced against the fleets (${balance.reason ?? "unknown"}). It is ` +
            `playing as the raw seeded deal, which may be lopsided. Restart the match if you'd rather not risk it.`
        );
      })
      .catch((e) => {
        battleStartedRef.current = false;
        setHostError(e instanceof Error ? e.message : String(e));
      });
  }, [state.room, state.myPlayer, state.players, state.teamReady]);

  // Remembers where you are so the top bar can offer a way back from the leaderboard, a captain's
  // page or the almanac - and forgets it the moment the room stops being somewhere you can return
  // to, so the link never points at a room that's gone.
  const hasPlayer = Boolean(state.myPlayer);
  const roomGone = !state.loading && !state.error && !state.room;
  useEffect(() => {
    if (!code) return;
    if (hasPlayer) setActiveRoom(code);
    else if (roomGone) clearActiveRoom(code);
  }, [code, hasPlayer, roomGone]);

  // The connection banner has to sit alongside whichever phase is showing, so the phase choice
  // is resolved in here and rendered inside a single fragment below rather than early-returned.
  function renderPhase() {
  if (state.loading) return <LoadingScreen>Loading room...</LoadingScreen>;
  // A real failure - no network, a rejected read - as opposed to a room that simply isn't there,
  // which is the case below and no longer arrives here. Given a way out for the same reason that
  // one has: whatever went wrong, a dead end is not the answer to it.
  if (state.error) {
    return (
      <div className="panel stack" style={{ width: "min(420px, 100%)", alignItems: "center", textAlign: "center" }}>
        <h2 style={{ margin: 0 }}>Couldn't open this room</h2>
        <p className="error-text" style={{ margin: 0 }}>{state.error}</p>
        <Link to="/">Return to harbor</Link>
      </div>
    );
  }

  // Deleted by an admin, or swept up by the room pruner while this tab sat open. Previously a bare
  // line of red text with nowhere to go from it.
  if (!state.room) {
    return (
      <div className="panel stack" style={{ width: "min(420px, 100%)", alignItems: "center", textAlign: "center" }}>
        <h2 style={{ margin: 0 }}>This room is gone</h2>
        <p className="muted" style={{ margin: 0 }}>
          {code ? formatRoomCode(code) : "That room"} has been closed, deleted, or cleared away after
          sitting idle. Nothing here to rejoin.
        </p>
        <Link to="/">
          Return to harbor
        </Link>
      </div>
    );
  }

  if (!state.myPlayer) {
    // A stored player id for this room with no matching row means the seat is gone rather than
    // never taken: kicked by the host, or removed by an admin. Say so, then offer the join form
    // underneath - rejoining is usually what you want next, and silently showing a fresh join
    // screen made it look as though nothing had happened.
    const wasHere = Boolean(code && getStoredPlayerId(code));
    return (
      <div className="stack" style={{ width: "min(400px, 100%)", gap: "0.6rem" }}>
        {wasHere && (
          <div className="panel stack" style={{ gap: "0.4rem", borderColor: "var(--danger)" }}>
            <strong>You're no longer in this room</strong>
            <span className="muted" style={{ fontSize: "0.85rem" }}>
              The host or an admin removed you. You can join again below, or head back out.
            </span>
            <Link to="/" style={{ fontSize: "0.85rem" }}>
              Return to harbor
            </Link>
          </div>
        )}
        <JoinForm code={state.room.code} />
      </div>
    );
  }

  const { room, players, myPlayer, myFleet, attacks, teamReady, deepHides } = state;
  const teamsList = activeTeams(players);

  if (room.status === "lobby") {
    return (
      <LobbyPhase
        room={room}
        players={players}
        myPlayer={myPlayer}
        onlinePlayerIds={state.onlinePlayerIds}
      />
    );
  }

  if (myPlayer.team === null) {
    // A finished match is the same recap for everyone, so spectators get the full report rather
    // than the live watching view (whose mode switcher has nothing left to reveal).
    if (room.status === "finished") {
      return (
        <div className="stack" style={{ alignItems: "center", width: "100%", gap: "0.9rem" }}>
          <MatchReport
            room={room}
            players={players}
            attacks={attacks}
            deepHides={deepHides}
            fleets={state.revealedFleets}
            activeTeamsList={teamsList}
          />
          {/* A spectating host still runs the room. Without this the only person who can open the
              next match had no button to do it with. */}
          <div className="stack" style={{ width: "min(320px, 100%)" }}>
            {myPlayer.is_host && <PlayAgainButton room={room} />}
            <LeaveMatchButton playerId={myPlayer.id} roomCode={room.code} spectating />
          </div>
        </div>
      );
    }
    return (
      <SpectatorView
        room={room}
        activeTeamsList={teamsList}
        attacks={attacks}
        deepHides={deepHides}
        fleets={state.revealedFleets}
        players={players}
        onlinePlayerIds={state.onlinePlayerIds}
        myPlayer={myPlayer}
      />
    );
  }

  const myTeam = myPlayer.team;

  if (!myFleet) return <LoadingScreen>Loading your fleet...</LoadingScreen>;

  if (room.status === "placement") {
    return (
      <PlacementPhase
        room={room}
        myTeam={myTeam}
        myPlayerId={myPlayer.id}
        myFleet={myFleet}
        players={players}
        activeTeamsList={teamsList}
        teamReady={teamReady}
        isHost={myPlayer.is_host}
      />
    );
  }

  if (room.status === "battle") {
    return (
      <BattlePhase
        room={room}
        myTeam={myTeam}
        myPlayerId={myPlayer.id}
        players={players}
        activeTeamsList={teamsList}
        myFleet={myFleet}
        attacks={attacks}
        deepHides={deepHides}
        teamReady={teamReady}
        isHost={myPlayer.is_host}
        onlinePlayerIds={state.onlinePlayerIds}
        rejoinCode={myPlayer.rejoin_code}
      />
    );
  }

  if (room.status === "finished") {
    return (
      <FinishedView
        room={room}
        myTeam={myTeam}
        myPlayerId={myPlayer.id}
        isHost={myPlayer.is_host}
        activeTeamsList={teamsList}
        players={players}
        attacks={attacks}
        deepHides={deepHides}
        fleets={state.revealedFleets}
      />
    );
  }

  return null;
  }

  return (
    <>
      <ConnectionBanner connection={state.connection} />
      {/* Rendered above the phase rather than inside it: the thing most likely to fail here is the
          automatic battle start, and the host may well be spectating when it does. */}
      {hostError && <div className="error-text">{hostError}</div>}
      {renderPhase()}
    </>
  );
}

function JoinForm({ code }: { code: string }) {
  const [nickname, setNickname] = useState(getLastNickname());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRejoin, setShowRejoin] = useState(false);
  const [rejoinCode, setRejoinCode] = useState("");

  // Same precedence as the Home page: a signed-in player's own nickname, then their Twitch name,
  // then whatever this browser last used. Arriving on a room link shouldn't hand you a different
  // name from the one the front page would have.
  const profile = useAuthProfile();
  const [touched, setTouched] = useState(false);
  const savedName = accountName(profile);
  useEffect(() => {
    if (!touched && savedName) setNickname(savedName.slice(0, NICKNAME_MAX));
  }, [savedName, touched]);

  async function handleRejoin() {
    if (!rejoinCode.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const playerId = await redeemRejoinCode(code, rejoinCode);
      if (!playerId) {
        setError("That rejoin code doesn't match anyone in this room.");
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  // Shared via the lobby's "Spectator link". Players join with team = null anyway, so this only
  // changes the framing - it tells the visitor what they're walking into rather than dropping
  // them on a team picker they didn't ask for.
  const spectating = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("spectate") === "1";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!nickname.trim()) return;
    setBusy(true);
    setError(null);
    try {
      storeLastNickname(nickname.trim());
      // Signed in? Then this is a rename, not just a name for this room - keep it on the account.
      // Failing to save it must not block the join, so the name they typed is used either way.
      if (profile?.isTwitch) await saveNickname(nickname.trim()).catch(() => {});
      await joinRoom(code, nickname.trim());
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="panel stack" style={{ width: "min(400px, 100%)" }}>
      <h2>{spectating ? `Spectate ${formatRoomCode(code)}` : `Join ${formatRoomCode(code)}`}</h2>
      {spectating && (
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          You'll join as a spectator. Pick a fleet in the lobby if you'd rather play.
        </p>
      )}
      <input
        value={nickname}
        onChange={(e) => {
          setTouched(true);
          setNickname(e.target.value);
        }}
        placeholder="Nickname"
        maxLength={NICKNAME_MAX}
        autoFocus
      />
      {profile?.isTwitch && (
        <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
          Your Twitch account keeps this name for next time.
        </span>
      )}
      {error && <div className="error-text">{error}</div>}
      <button type="submit" className="primary" disabled={busy}>
        {spectating ? "Spectate" : "Join"}
      </button>

      {showRejoin ? (
        <div className="stack" style={{ gap: "0.35rem" }}>
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            Enter the rejoin code from your previous session to take back that fleet.
          </span>
          <div className="row" style={{ gap: "0.4rem" }}>
            <input
              style={{ flex: 1, textTransform: "uppercase" }}
              value={rejoinCode}
              onChange={(e) => setRejoinCode(e.target.value)}
              placeholder="Rejoin code"
              maxLength={8}
            />
            <button type="button" disabled={busy} onClick={handleRejoin}>
              Rejoin
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowRejoin(true)}
          style={{ fontSize: "0.75rem", background: "none", border: "none", color: "var(--text-dim)" }}
        >
          Played here before? Use a rejoin code
        </button>
      )}
    </form>
  );
}

type SpectatorMode = "attacks" | "all" | "crew" | number;

/** Stable identity, so hiding the board does not re-render the whole spectator view. */
const NO_CHALLENGES: Challenge[] = [];

/**
 * The eval bar, wrapped so that its clock ticks in here and nowhere else.
 *
 * The wrapper exists for one reason and it is not tidiness. useBattleClock re-renders its caller
 * once a second, and the axis under the history line needs the match clock - so reading it up in
 * SpectatorView would have repainted the entire page every second: both full boards, the log, and
 * every roster. That is the exact cost useBattlePhaseName was introduced to avoid, and the reason
 * useRoom says the clock was moved out of the top of the match tree.
 *
 * Down here the tick reaches one panel. The model itself stays up in SpectatorView, because
 * useVictoryOdds is keyed on the shot count and so recomputes about once a minute rather than once
 * a second - it is the clock that is expensive to place, not the odds.
 */
function SpectatorOdds({
  attacks,
  room,
  snapshot,
  points,
  showGraph,
}: {
  attacks: Attack[];
  room: RoomType;
  snapshot: OddsSnapshot | null;
  points: OddsPoint[];
  showGraph: boolean;
}) {
  const phase = useBattleClock(attacks, room);
  return (
    <OddsPanel
      snapshot={snapshot}
      points={points}
      elapsed={phase?.phase === "match" ? formatDuration(phase.matchElapsed) : "--:--"}
      showGraph={showGraph}
    />
  );
}

function SpectatorView({
  room,
  activeTeamsList,
  attacks,
  deepHides,
  fleets,
  players,
  onlinePlayerIds,
  myPlayer,
}: {
  room: RoomType;
  activeTeamsList: number[];
  attacks: Attack[];
  /** The hiding places that have been fired at - see lib/deepWater.ts. */
  deepHides: DeepHide[];
  fleets: Fleet[];
  /** The room's roster: tally attribution, the rail's rosters, and the host-takeover check. */
  players: Player[];
  onlinePlayerIds: string[];
  myPlayer: Player;
}) {
  // The stage the boards are measured into. See Spectator.css for why this page measures rather
  // than capping boards in vh.
  const [stageRef, stage] = useBoxSize<HTMLDivElement>();

  /**
   * Correct the byte meter's guess about what this tab is.
   *
   * /room/:code is the same URL for a player and a spectator, so lib/egressMeter reads "player" off
   * the route and cannot do better. This component only mounts for somebody whose team is null, so
   * it is the one place that knows. Worth the two lines: spectators and overlays are where a match's
   * realtime cost actually comes from, and a split that filed them all as players would say nothing.
   */
  useEffect(() => setEgressRole("spectator"), []);

  // Defaults to "attacks": shot results only, no ship positions. That's the mode that stays
  // honest if a spectator is also a player's second tab, so it shouldn't require opting in.
  const [view, setView] = useState<SpectatorMode>("attacks");
  // Separate from `view` so switching to a crew and back doesn't forget which crew you were with.
  const [ridingWith, setRidingWith] = useState<number | null>(null);
  // Open by default: a caster who doesn't know the log and rosters are available can't ask for them.
  const [railOpen, setRailOpen] = useState(true);
  /**
   * The evaluation bar, in the rail.
   *
   * On by default and remembered, for the same reason the rail is: a watcher who doesn't know it's
   * there can't ask for it. Stored rather than plain state because this is a preference about how
   * somebody likes to watch, and re-deciding it every time they open a room is the kind of small
   * friction that makes a feature feel like it is in the way.
   *
   * Safe to show HERE and nowhere else in the room. This whole component only mounts for a player
   * whose team is null - a genuine spectator - so the rule the overlays keep holds: the odds are for
   * people watching, never for somebody still playing, because a crew who can see their own chances
   * swing is being told something about the board the match is supposed to make them work out.
   */
  const [oddsOn, setOddsOn] = useStoredToggle("eb_spectate_odds", true);

  /**
   * The model, run only while somebody is looking at it.
   *
   * `oddsOn` is passed twice on purpose - once as "draw the history line", once as "run at all".
   * This is a Monte Carlo of ten thousand matches replayed across the whole log, so a spectator who
   * has collapsed the panel must not still be paying for it once a minute for the rest of the
   * match. See the `enabled` note in useVictoryOdds.
   *
   * The clock is read separately from the one in the bar because the axis under the history line is
   * the match clock, and it is the only scale that line means anything on.
   */
  const oddsLive = railOpen && oddsOn;
  const { snapshot, timeline } = useVictoryOdds(attacks, room, players, oddsLive, oddsLive);

  const { status, board_size: boardSize, ship_defs: shipDefs, winner_team: winnerTeam } = room;
  // The same squares the players are looking at. Derived from the room exactly as BattlePhase
  // derives it - id, set and seed - so a spectator calling out "they just took C4" is naming the
  // square the fleet has on their own screen.
  const dealtChallenges = useMemo(
    () => challengesForRoom(room.id, boardSize * boardSize, room.square_set, room.seed, room.board_perm),
    [room.id, boardSize, room.square_set, room.seed, room.board_perm]
  );
  // Held back through the RANDOMIZATION window, on the same beat as the players own board and the
  // overlays - a spectator reading out the squares ten seconds before the crews can see them would
  // be calling a board that is still being dealt. See lib/overlayReveal.ts.
  const battlePhase = useBattlePhaseName(attacks, room);
  const challenges = squaresRevealed(room.status, battlePhase) ? dealtChallenges : NO_CHALLENGES;
  /**
   * Everything in the water, for the caster (see lib/deepWater.ts).
   *
   * No team passed, which is `deepMarks` for "shows me the lot". Spectators are the one audience that
   * gets it for free: a caster can't call a match they're being kept in the dark about, and unlike a
   * player, knowing which squares are open water tells them nothing they could use, because they
   * aren't holding a fleet. Players still see only their own crew's finds.
   */
  const deep = useMemo(
    () => deepWater(room, groupIntoShots(attacks, players), deepHides, igonAnchor(room)),
    [room, attacks, players, deepHides]
  );
  const deepCells = useMemo(() => deepMarks(deep), [deep]);

  // Every shot in the room is audible from here - see useSpectatorSfx for why it's one sound per shot
  // rather than per attack row, and why the whale needs `deepCells` to be heard at all. Sits below the
  // memo it reads rather than at the top of the component, which would be a use-before-declaration.
  useSpectatorSfx(attacks, true, deepCells);

  const overShoulder = view === "crew" && ridingWith !== null;
  const shown = view === "attacks" || view === "all" ? activeTeamsList : typeof view === "number" ? [view] : [];
  const showShips = view !== "attacks";
  /**
   * Wrecks per fleet, not per board.
   *
   * This used to be one room-wide map, which forced the cell test below to also require a 'sunk'
   * attack row on that exact square before it would draw a wreck - otherwise one fleet's hull
   * geometry would have painted wreckage onto the same squares of every other fleet's board. The
   * side effect was that only the KILLING square of a hull ever showed as sunk here, while the
   * fleets' own boards show the whole hull burning. A spectator watching a five-cell ship go down
   * saw four hit markers and one wreck, which reads as a ship sinking a hit early - and that is
   * exactly how it was reported.
   *
   * Keyed by defender, the geometry can't cross boards, so the whole hull can be drawn.
   */
  const sunkByTeam = useMemo(() => {
    const out = new Map<number, Map<number, boolean>>();
    for (const team of activeTeamsList) {
      out.set(
        team,
        sunkCellOrientations(
          attacks.filter((a) => a.defender_team === team),
          boardSize
        )
      );
    }
    return out;
  }, [attacks, activeTeamsList, boardSize]);
  const sunkFor = (team: number) => sunkByTeam.get(team) ?? new Map<number, boolean>();

  /**
   * Each shown fleet's board, resolved in one walk of the log per fleet.
   *
   * This is the page that most needed it: the per-cell filter it replaces ran once per square PER
   * FLEET, so a four-fleet view filtered the whole attack log four hundred times to draw one frame.
   * See lib/cellVisuals.
   */
  const visualsByTeam = useMemo(() => {
    const out = new Map<number, Map<number, CellVisual>>();
    for (const team of activeTeamsList) {
      out.set(
        team,
        cellVisuals(
          attacks.filter((a) => a.defender_team === team),
          sunkByTeam.get(team) ?? EMPTY_SUNK
        )
      );
    }
    return out;
  }, [attacks, activeTeamsList, sunkByTeam]);
  // Who is out, for the rail's rosters. From the public attack log rather than team_ready, which a
  // fleet that lost its last hull and closed the tab never gets to write.
  const eliminatedTeams = eliminatedTeamsFromAttacks(attacks, shipDefs.length);

  /**
   * Every fleet's square counters, resolved to chips a board can print.
   *
   * Gated on the same switch as ship positions, deliberately. A tally is a fleet's working-out -
   * what they're chasing and how far along they are - which is exactly what the RLS policy keeps
   * from opponents, so a spectator who is really a player's second tab must not be handed it in the
   * mode that promises to reveal nothing. "Attacks only" stays honest; every other mode has already
   * opened the fleets up.
   */
  const spectatorCounts = useSpectatorCounts(room.id);
  const countsByTeam = useMemo(() => {
    const out = new Map<number, ReturnType<typeof countChips>>();
    if (!showShips) return out;
    const byId = new Map(players.map((p) => [p.id, p]));
    const name = (pid: string) => byId.get(pid)?.nickname ?? "Someone";
    for (const [team, counts] of spectatorCounts) out.set(team, countChips(counts, name));
    return out;
  }, [spectatorCounts, players, showShips]);

  function visualFor(team: number) {
    const visuals = visualsByTeam.get(team);
    return (index: number): CellVisual => visuals?.get(index) ?? "empty";
  }

  /** A team's ships, drawn from their fleet row (spectator-only read). */
  function shipsFor(team: number): ShipOverlay[] {
    if (!showShips) return [];
    const fleet = fleets.find((f) => f.team === team);
    return (fleet?.placements ?? []).map((p) => ({
      row: p.startRow,
      col: p.startCol,
      size: shipDefs[p.shipIndex].size,
      horizontal: p.isHorizontal,
      shipName: shipDefs[p.shipIndex].name,
      colorHex: teamHex(team),
    }));
  }

  const canSeeShips = fleets.length > 0;

  const side = boardSideFor(stage, shown.length);
  const cols = boardColumns(shown.length);

  /**
   * The same move/resize panels the fleets have, bound to this page's panel set.
   *
   * Which panels exist here depends on the room and the mode - one board per fleet on show, two in
   * "with <fleet>", plus the log and rosters - so the defaults are computed per render rather than
   * written down (see defaultSpectatorLayout). Only panels the caster has actually dragged are
   * stored, which is what lets a board they never touched re-tile itself when a fleet joins.
   */
  const boardPanelIds: SpectatorPanelId[] = overShoulder
    ? ["crewFire", "crewFleet"]
    : shown.map(teamPanelId);
  const boardKey = boardPanelIds.join("|");
  const panelIds = spectatorPanelIds(boardPanelIds, railOpen, oddsOn);
  const spectatorDefaults = useMemo(
    () => defaultSpectatorLayout(boardPanelIds, railOpen, oddsOn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardKey, railOpen, oddsOn]
  );
  const {
    layout,
    setPanel,
    setStack,
    reset: resetLayout,
    enabled: canvasOn,
    setEnabled: setCanvasOn,
    locked,
    setLocked,
  } = usePanelLayout<SpectatorPanelId>("eb_spectate_layout", panelIds, spectatorDefaults);

  // Canvas pixel size, so stored fractions can be resolved and drag deltas converted back into
  // fractions - measured for the same reason the match canvas measures its own. See BattlePhase.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 1, h: 1 });
  useEffect(() => {
    const el = canvasRef.current;
    if (!canvasOn || !el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setCanvasSize({ w: Math.max(1, width), h: Math.max(1, height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasOn]);

  const panelProps = (id: SpectatorPanelId, title: string) => ({
    title,
    box: layout[id],
    canvas: canvasSize,
    onChange: (b: PanelBox) => setPanel(id, b),
    locked,
    onRestack: (to: "front" | "back") => setStack(id, to),
  });

  const cellText = (i: number) => {
    const c = challenges[i];
    if (!c) return null;
    return {
      label: c.short ?? c.name,
      title: c.title ?? c.name,
      region: c.region,
      color: c.color,
    };
  };

  /** The fleet cards, shared by the rail and the canvas so the two can't drift apart. */
  const rosters = activeTeamsList.map((t) => (
    <TeamBox
      key={t}
      team={t}
      players={players}
      shipDefs={shipDefs}
      // Read off the resolved attack log, exactly as a player's own roster is - never from the
      // fleet rows, so the roster says the same thing in "Attacks only" mode as it does with
      // every ship revealed.
      sunkHulls={sunkHullFlags(attacks, t, shipDefs)}
      eliminated={eliminatedTeams.has(t)}
    />
  ));

  return (
    <div className="spectate">
      {/* A watcher may not call a pause, but must be able to see one - a caster whose clock has
          silently stopped has nothing to say about it on air. Fixed over the page, like it is over
          the boards on a player's screen, and null for the whole of almost every match. */}
      <PauseBanner room={room} players={players} myPlayerId={myPlayer.id} isHost={myPlayer.is_host} />

      {/*
        One bar holding everything that isn't a board.

        The clock leads it, because the clock is the thing a caster reads most and the thing that
        used to be furthest from where they were looking. Nothing in here scrolls, so it can't go
        missing at any window size - which it did when this page was an ordinary stack taller than
        the viewport.
      */}
      <div className="spectate-bar">
        <MatchClock attacks={attacks} room={room} compact />

        {status === "finished" && winnerTeam !== null && (
          <strong style={{ color: teamHex(winnerTeam), fontSize: "0.85rem" }}>
            {teamName(winnerTeam)} wins
          </strong>
        )}

        <span className="spectate-divider" />
        <span className="spectate-label">Spectating</span>

        <button
          onClick={() => setView("attacks")}
          style={{ borderColor: view === "attacks" ? "var(--accent)" : undefined }}
          title="Shot results only - no ship positions revealed"
        >
          Attacks only
        </button>
        <button
          onClick={() => setView("all")}
          style={{ borderColor: view === "all" ? "var(--accent)" : undefined }}
          title="Every fleet's ships"
        >
          All fleets
        </button>
        {activeTeamsList.map((t) => (
          <button
            key={t}
            onClick={() => setView(t)}
            style={{ borderColor: view === t ? teamHex(t) : undefined, color: teamHex(t) }}
            title={`Only ${teamName(t)}'s ships`}
          >
            {teamName(t)}
          </button>
        ))}

        <span className="spectate-divider" />

        {/* Ride along with a crew: their exact two-board view, read-only. Built for someone sitting
            in the same Discord call as a team - they need to see what that team is looking at,
            including which squares the team has already tried, not a neutral overhead of both. */}
        {activeTeamsList.map((t) => (
          <button
            key={`crew${t}`}
            onClick={() => {
              setRidingWith(t);
              setView("crew");
            }}
            style={{
              borderColor: overShoulder && ridingWith === t ? teamHex(t) : undefined,
              color: teamHex(t),
            }}
            title={`See what ${teamName(t)} sees: their fleet and their shots. You still can't fire`}
          >
            With {teamName(t)}
          </button>
        ))}

        {/* Notes that used to sit between the switcher and the boards, where they pushed the boards
            down. In the bar they cost nothing the stage was using. */}
        {!overShoulder && status === "placement" && (
          <span className="spectate-note">
            {showShips && canSeeShips
              ? "Fleets are being placed. Each hull appears as its captain puts it down, and can still move until they confirm."
              : "Every fleet is placing their ships..."}
          </span>
        )}
        {!overShoulder && showShips && !canSeeShips && status !== "placement" && (
          <span className="spectate-note">
            Ship positions are hidden. Apply the <code>fleets select by spectator</code> policy to show them.
          </span>
        )}

        {/* Same key the fleets have along the bottom of their own screen. A caster reading a board
            they didn't build needs it more than anyone, and in the bar it costs a line nothing else
            was using. Renders nothing on a set that tints nothing. */}
        <BoardLegend challenges={challenges} setId={room.square_set} inline />

        <span className="spectate-bar-spacer" />

        {/* A spectator is often the only person still watching when a host drops. */}
        <HostTakeover
          players={players}
          onlinePlayerIds={onlinePlayerIds}
          myPlayerId={myPlayer.id}
          inline
        />

        {/* Opened from here rather than from the lobby: the person driving a stream board is
            almost always already sitting on this page watching the match. */}
        <Link
          to={`/cast/${room.code}`}
          target="_blank"
          rel="noreferrer"
          className="spectate-cast-link"
          title="Drive the OBS board source: swap fleets, zoom and pan for viewers"
        >
          Board control
        </Link>

        <button
          onClick={() => setRailOpen(!railOpen)}
          style={{ borderColor: railOpen ? "var(--accent)" : undefined }}
          title="Show the battle log and fleet rosters beside the boards."
          aria-pressed={railOpen}
        >
          {railOpen ? "Hide log" : "Log & rosters"}
        </button>

        {/* Only offered while the rail is open, because the rail is what it lives in - a toggle for
            a panel that has nowhere to be is a control that does nothing when pressed. */}
        {railOpen && (
          <button
            onClick={() => setOddsOn(!oddsOn)}
            style={{ borderColor: oddsOn ? "var(--accent)" : undefined }}
            title="Each fleet's chance of winning, and the line that got them there."
            aria-pressed={oddsOn}
          >
            Odds
          </button>
        )}

        {/* The fleets' own move/resize panels, on this page too. A caster's needs are less uniform
            than a player's - one is reading squares aloud off a single board, another is watching
            four fleets at once - so the arrangement being theirs matters more here, not less.
            On by default, exactly as it is in a match, with the same lock beside it. */}
        {/*
          Names the mode it would switch TO, and so is styled as an action rather than a state.
          It used to carry the accent border and aria-pressed while the canvas was on, from when the
          canvas was the opt-in extra and the button meant "this is turned on". Now that the canvas is
          simply how the page works, that reads backwards in both directions at once: the highlight
          claims "Fixed layout" is the current mode, and a screen reader announces "Fixed layout,
          pressed" at exactly the moment the panels are movable. The lock beside it is still a state,
          and still styled like one.
        */}
        <button
          onClick={() => setCanvasOn(!canvasOn)}
          title="Drag panels by their title bar; resize from the bottom-right corner"
        >
          {canvasOn ? "Fixed layout" : "Move / resize panels"}
        </button>
        {canvasOn && (
          <>
            <button
              onClick={() => setLocked(!locked)}
              style={{ borderColor: locked ? "var(--accent)" : undefined }}
              title={
                locked
                  ? "Panels are frozen. Unlock to move, resize or restack them."
                  : "Freeze every panel where it is."
              }
              aria-pressed={locked}
            >
              {locked ? "🔒 Locked" : "🔓 Lock layout"}
            </button>
            {/* Still offered while locked - it's the escape hatch for a panel dragged out of reach. */}
            <button onClick={resetLayout} title="Put every panel back where it started">
              Reset layout
            </button>
          </>
        )}

        {/* A host who is spectating keeps every host power they'd have on a fleet - ending the
            match is the one that matters here, since nobody else in the room can do it. Stopping the
            clock is the second: the host is often the caster, and the caster is often the person who
            can see that the room needs a minute.

            Offered to the host alone, not to every spectator. A pause REQUEST is harmless enough on
            its own, but a published room code means the gallery is strangers, and a chime anybody
            passing can ring in a live match is the sort of thing spectators_cannot_disrupt exists to
            keep out. Watchers still see the banner, which is the part they need. */}
        {myPlayer.is_host && (
          <PauseControls room={room} players={players} myPlayerId={myPlayer.id} isHost />
        )}
        {myPlayer.is_host && <EndMatchButton roomId={room.id} />}
        <LeaveMatchButton playerId={myPlayer.id} roomCode={room.code} spectating />
      </div>

      {canvasOn ? (
        <div className="spectate-canvas" ref={canvasRef}>
          {overShoulder ? (
            <SpectateWithCrew
              room={room}
              team={ridingWith!}
              attacks={attacks}
              fleets={fleets}
              activeTeamsList={activeTeamsList}
              counts={countsByTeam.get(ridingWith!)}
              deep={deep}
              stage={stage}
              wrapBoard={(id, title, node) => (
                <CanvasPanel key={id} {...panelProps(id, title)} flush>
                  {node}
                </CanvasPanel>
              )}
            />
          ) : (
            shown.map((team) => (
              <CanvasPanel key={team} {...panelProps(teamPanelId(team), teamName(team))} flush>
                <BoardGrid
                  boardSize={boardSize}
                  cellVisual={visualFor(team)}
                  ships={shipsFor(team)}
                  sunkOrientation={sunkFor(team)}
                  counts={countsByTeam.get(team)}
                  cellText={cellText}
                  deepCells={deepCells}
                  // The panel is the budget here, so the board takes its shape from what the
                  // caster dragged rather than from a square derived off the viewport.
                  fill
                />
              </CanvasPanel>
            ))
          )}

          {railOpen && (
            <>
              {/* Its own panel, so a caster who wants the eval bar big can drag it big - which is
                  the whole argument for the canvas. The history line comes with it here, because a
                  panel somebody sized themselves has room for the reasoning as well as the number. */}
              {oddsOn && (
                <CanvasPanel {...panelProps("odds", "Odds of victory")} flush>
                  <SpectatorOdds attacks={attacks} room={room} snapshot={snapshot} points={timeline} showGraph />
                </CanvasPanel>
              )}
              <CanvasPanel {...panelProps("log", "Battle log")} flush>
                <AttackFeed
                  attacks={attacks}
                  players={players}
                  boardSize={boardSize}
                  challenges={challenges}
                  room={room}
                  maxHeight="100%"
                  deepCells={deepCells}
                  igon={deep.igon}
                />
              </CanvasPanel>
              <CanvasPanel {...panelProps("roster", "Fleets")}>
                <div className="stack" style={{ gap: "0.4rem" }}>{rosters}</div>
              </CanvasPanel>
            </>
          )}
        </div>
      ) : (
      <div className="spectate-stage">
        {/* The ref is on the BOARD area, not on the stage: boardSideFor measures whatever it is
            given, so leaving it on the stage would size the boards as though the rail beside them
            weren't there and push them straight back off the bottom of the window. */}
        <div className="spectate-boards" ref={stageRef}>
        {overShoulder ? (
          <SpectateWithCrew
            room={room}
            team={ridingWith!}
            attacks={attacks}
            fleets={fleets}
            activeTeamsList={activeTeamsList}
            counts={countsByTeam.get(ridingWith!)}
            deep={deep}
            stage={stage}
          />
        ) : (
          <div className="spectate-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {shown.map((team) => (
              <BoardGrid
                key={team}
                boardSize={boardSize}
                cellVisual={visualFor(team)}
                label={teamName(team)}
                ships={shipsFor(team)}
                sunkOrientation={sunkFor(team)}
                // That fleet's own tallies on that fleet's board. No onCount, so the wheel still
                // scrolls the page from here - a spectator annotates nothing.
                counts={countsByTeam.get(team)}
                // The same finds the battle log beside this board is already calling out. Without
                // it a caster read "something is down there at C4" in the feed and then found a
                // plain splash on C4, which is the one square they most needed to be able to point at.
                deepCells={deepCells}
                // Both bounds are the same measured square, which is what BoardGrid's
                // min(maxVh, maxVw, 1600px) resolves to - so the board is exactly as big as the
                // space actually left for it, on any monitor.
                maxVh={`${side}px`}
                maxVw={`${side}px`}
                cellText={cellText}
              />
            ))}
          </div>
        )}
        </div>

        {/*
          The caster's rail: the battle log and the fleet rosters, the two things a player has beside
          their own board and a spectator previously had to do without. Without them the boards say
          what happened but never who did it - "someone took C4" rather than "Aljex took C4" - and
          nothing at all about how many hulls each fleet has left.

          Collapsible, because the stage is a fixed budget and every pixel the rail takes comes off
          the boards. A caster reading squares aloud wants the boards big; one following a close
          endgame wants the roster. Neither is the right permanent default, so it's a button.
        */}
        {railOpen && (
          <aside className="spectate-rail">
            {/* No history line in the fixed rail. The rail is a fixed narrow column, so the graph
                would be bought entirely out of the battle log's height - and the bar alone IS the
                reading. Anyone who wants the line can drag the panel out on the canvas. */}
            {oddsOn && (
              <div className="spectate-rail-odds">
                <SpectatorOdds
                  attacks={attacks}
                  room={room}
                  snapshot={snapshot}
                  points={timeline}
                  showGraph={false}
                />
              </div>
            )}
            <AttackFeed
              attacks={attacks}
              players={players}
              boardSize={boardSize}
              challenges={challenges}
              room={room}
              maxHeight="100%"
              deepCells={deepCells}
              igon={deep.igon}
            />
            <div className="spectate-rail-rosters">{rosters}</div>
          </aside>
        )}
      </div>
      )}
    </div>
  );
}

function FinishedView({
  room,
  myTeam,
  myPlayerId,
  isHost,
  activeTeamsList,
  players,
  attacks,
  deepHides,
  fleets,
}: {
  room: RoomType;
  myTeam: number;
  myPlayerId: string;
  isHost: boolean;
  activeTeamsList: number[];
  players: Player[];
  attacks: Attack[];
  deepHides: DeepHide[];
  fleets: Fleet[];
}) {
  const [error, setError] = useState<string | null>(null);
  const won = room.winner_team === myTeam;
  const draw = room.winner_team === null;

  return (
    <div className="stack" style={{ alignItems: "center", width: "100%", gap: "0.9rem" }}>
      <p className="muted" style={{ margin: 0, fontSize: "1.05rem" }}>
        {draw
          ? "The last fleets sank each other."
          : won
            ? "You're the last fleet afloat."
            : `${room.winner_team !== null ? teamName(room.winner_team) : "Another fleet"} is the last one afloat.`}
      </p>

      <MatchReport
        room={room}
        players={players}
        attacks={attacks}
        deepHides={deepHides}
        fleets={fleets}
        activeTeamsList={activeTeamsList}
      />

      {/* Switching sides is allowed here as well as in the lobby, so a crew can reshuffle without
          having to wait on the host resetting the room first - and without the only window being
          a lobby that reappears for a few seconds before placement starts. */}
      <div style={{ width: "min(560px, 100%)" }}>
        <TeamPicker
          room={room}
          playerId={myPlayerId}
          currentTeam={myTeam}
          players={players}
          onError={setError}
        />
      </div>

      {error && <div className="error-text">{error}</div>}
      {/* Host only, deliberately. Starting the next match clears the attack log, and that right is
          not handed to the room at large - see the "attacks delete by host" policy. A crew whose
          host has gone dark isn't stuck: presence exposes a "Become host" takeover in the lobby. */}
      <div className="stack" style={{ width: "min(320px, 100%)", gap: "0.4rem" }}>
        {isHost ? (
          <PlayAgainButton room={room} />
        ) : (
          <p className="muted" style={{ textAlign: "center", margin: 0 }}>
            Waiting for the host to start a new match...
          </p>
        )}
        {/* Between matches is the natural moment to bow out, so the way out lives here rather than
            only in the lobby everyone passes through in seconds. */}
        <LeaveMatchButton playerId={myPlayerId} roomCode={room.code} inMatch={false} label="Leave room" />
      </div>
    </div>
  );
}

/**
 * Sends the room back to the lobby for another match. Host only.
 *
 * Shared by the player's recap and the spectating host's, which is the whole reason it's its own
 * component - a host who isn't on a fleet sees the spectator's finished screen, and that screen
 * previously had no way to start the next game.
 */
function PlayAgainButton({ room }: { room: RoomType }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePlayAgain() {
    setBusy(true);
    setError(null);
    try {
      await resetRoomToLobby(room.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <button className="primary" disabled={busy} onClick={() => void handlePlayAgain()}>
        {busy ? "Starting..." : "Play again"}
      </button>
      {error && <div className="error-text">{error}</div>}
    </>
  );
}
