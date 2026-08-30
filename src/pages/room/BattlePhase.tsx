import { useEffect, useMemo, useRef, useState } from "react";
import { BoardGrid, type CellVisual, type ShipOverlay } from "../../components/BoardGrid";
import { useSquareCounts, countChips } from "../../hooks/useSquareCounts";
import { sendAttack } from "../../lib/rooms";
import { playSfx } from "../../lib/sfx";
import { teamName, teamHex } from "../../lib/teamColors";
import { EndMatchButton } from "../../components/EndMatchButton";
import { PauseBanner, PauseControls } from "../../components/PauseControls";
import { LeaveMatchButton } from "../../components/LeaveMatchButton";
import { OverlayLinkBox } from "../../components/OverlayLinkBox";
import { MatchInfoBox } from "../../components/MatchInfoBox";
import { TeamBox } from "../../components/TeamBox";
import { AttackFeed } from "../../components/AttackFeed";
import { MatchClock } from "../../components/MatchClock";
import { BoardLegend } from "../../components/BoardLegend";
import { CanvasPanel } from "../../components/CanvasPanel";
import { MatchDock } from "../../components/MatchDock";
import { FireHoldSelect } from "../../components/FireHoldSelect";
import { AutoFireStatus } from "../../components/AutoFireStatus";
import { FIRE_HOLD_DEFAULT, FIRE_HOLD_KEY, FIRE_HOLD_VALUES } from "../../lib/fireHold";
import { HostTakeover } from "../../components/HostTakeover";
import { useMatchLayout } from "../../hooks/useMatchLayout";
import { PANEL_TITLES, type PanelBox, type PanelId } from "../../lib/matchLayout";
import { challengesForRoom, rowSquareSet, igonAnchor, type Challenge } from "../../lib/challenges";
import { squaresRevealed } from "../../lib/overlayReveal";
import { groupIntoShots } from "../../lib/attackFeed";
import { deepWater, deepMarks, bottleNote, type DeepHide, type DeepMark } from "../../lib/deepWater";
import { buildPlayerStats } from "../../lib/matchReport";
import { buildRecordBook, type RecordEntry } from "../../lib/recordBook";
import { recordChases, liveTallies } from "../../lib/recordChase";
import { RecordChases } from "../../components/RecordChases";
import { fetchParticipants } from "../../lib/profiles";
import { cellLabel, sunkCellOrientations, eliminatedTeamsFromAttacks, sunkHullFlags } from "../../lib/battleshipLogic";
import { cellVisuals } from "../../lib/cellVisuals";
import { useBattlePhaseName } from "../../hooks/useBattlePhase";
import { usePencilMarks, NOTE_HINT } from "../../hooks/usePencilMarks";
import { useStoredToggle, useStoredNumber } from "../../hooks/useStoredToggle";
import { ruledOutCells, AUTO_RULE_HINT } from "../../lib/deduction";
import type { Room, Fleet, Player, Attack, TeamReady } from "../../types/battleship";

/** Stable identity, so hiding the board does not re-render every panel on each tick. */
const NO_CHALLENGES: Challenge[] = [];

/** Remembered per browser, not per room - it's how someone likes to read a board. */
const AUTO_RULE_KEY = "eb_auto_rule_v2";
/** Poisoned with defaults nobody chose while this was still opt-in. See useStoredToggle. */
const LEGACY_AUTO_RULE_KEY = "eb_auto_rule";

interface Props {
  room: Room;
  myTeam: number;
  myPlayerId: string;
  players: Player[];
  activeTeamsList: number[];
  myFleet: Fleet;
  attacks: Attack[];
  /** The hiding places this crew's shots have uncovered - see lib/deepWater.ts. */
  deepHides: DeepHide[];
  teamReady: TeamReady[];
  isHost: boolean;
  /** Presence, so a host who drops mid-match doesn't strand the room. See HostTakeover. */
  onlinePlayerIds: string[];
  /** Doubles as the spoiler overlay's credential for reading its own fleet. */
  rejoinCode?: string | null;
}

export function BattlePhase({
  room,
  myTeam,
  myPlayerId,
  players,
  activeTeamsList,
  myFleet,
  attacks,
  deepHides,
  teamReady,
  isHost,
  onlinePlayerIds,
  rejoinCode,
}: Props) {
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seenResolved = useRef(new Set<string>());
  /**
   * Every cell this browser has fired at, from the moment the click is accepted.
   *
   * `outgoing` can't do this job alone: it only knows about shots that have come back through
   * realtime, and there is a window of a few hundred milliseconds between the insert being sent and
   * the row arriving where a second click at the same square passes every check. That window is how
   * one square gets two attack rows, which used to mean two wounds on the same piece of hull - see
   * the 20260803 migration for the other half of the fix.
   *
   * Entries are removed only when the shot actually FAILED, so a square that couldn't be fired at
   * can be tried again; a successful one stays forever, because it can never need firing at twice.
   */
  const firedRef = useRef(new Set<number>());

  const boardSize = room.board_size;
  const shipDefs = room.ship_defs;
  const opponentTeams = activeTeamsList.filter((t) => t !== myTeam);
  const dealtChallenges = useMemo(
    () => challengesForRoom(room.id, boardSize * boardSize, room.square_set, room.seed, room.board_perm),
    [room.id, boardSize, room.square_set, room.seed, room.board_perm]
  );

  const incoming = attacks.filter((a) => a.defender_team === myTeam);
  const outgoing = attacks.filter((a) => a.attacker_team === myTeam);
  // Merge the public attack-log verdict with team_ready: a team that lost its last ship and then
  // closed the tab never gets to write its own eliminated flag, but the log still proves it.
  const eliminated = eliminatedTeamsFromAttacks(attacks, shipDefs.length);
  for (const t of teamReady) {
    if (t.eliminated) eliminated.add(t.team);
  }

  // Firing only opens once MATCH begins - STARTING/PREPARATION are a countdown buffer first.
  //
  // The NAME, not the clock: all this component wants is the boolean below, and taking the ticking
  // variant meant re-rendering both boards every second to re-derive a value that changes twice a
  // match. The clock panel draws the seconds itself. See useBattlePhase.
  const battlePhase = useBattlePhaseName(attacks, room);
  const canFire = battlePhase === "match";

  /**
   * What the board is allowed to say yet.
   *
   * The squares are still being dealt through the RANDOMIZATION window, which is what it is for, so
   * until it ends this component has no board to show, and everything downstream of here
   * reads an empty list: no names on the fire board, no region tint under your own hulls, no colour
   * key, nothing in the dock. Gated once, here, rather than at each of the six places that draw
   * some part of a square, because those are easy to add a seventh to and never notice.
   *
   * `squaresRevealed` is the same rule the overlays follow, so a stream and the players it is
   * pointed at reveal the board on the same beat. See lib/overlayReveal.ts.
   */
  const challenges = squaresRevealed(room.status, battlePhase) ? dealtChallenges : NO_CHALLENGES;

  const { marks, toggle: toggleMark, clear: clearPencilMarks } = usePencilMarks(room.code);

  /**
   * "Cross out dead water for me": squares no hull still afloat could possibly be sitting on.
   *
   * ON, and remembered per browser only once somebody says otherwise. It used to be opt-in on the
   * grounds that it is a fleet reading the board FOR you - but the arithmetic it does is arithmetic
   * every board reader is doing by hand anyway and losing track of, and a deduction that only helps
   * the players who found the button is not a level board.
   *
   * That flip was made once before and reached nobody: the old key was written on mount, so every
   * browser that had ever opened a match was carrying an "off" it had stored for itself while the
   * feature was still opt-in, and the read treated it as a decision. The key is retired here rather
   * than migrated, for the reason set out in useStoredToggle - which is also why this no longer
   * persists anything until the button is actually clicked.
   */
  const [autoRule, setAutoRule] = useStoredToggle(AUTO_RULE_KEY, true, LEGACY_AUTO_RULE_KEY);

  /**
   * How long a square has to be held down before it fires. See lib/fireHold for why it's a choice.
   *
   * Per browser like the toggle above, and for the same reason - it is how somebody plays, not
   * something about this room. Nothing is stored until a choice is made, so the default can still
   * be retuned later for everyone who never touched it.
   */
  const [fireHoldMs, setFireHoldMs] = useStoredNumber(FIRE_HOLD_KEY, FIRE_HOLD_DEFAULT, FIRE_HOLD_VALUES);

  const {
    counts: rawCounts,
    bump: bumpCount,
    clear: clearCounts,
    mineCount,
    writeError: countError,
  } = useSquareCounts({ roomId: room.id, roomCode: room.code, playerId: myPlayerId, team: myTeam });

  // One "you have written on the board" total, because one button clears both kinds.
  const noteCount = marks.size + mineCount;
  const clearMarks = () => {
    clearPencilMarks();
    clearCounts();
  };

  // Tallies, resolved from player ids to something a square can print. See countChips.
  const countsByCell = useMemo(() => {
    const byId = new Map(players.map((p) => [p.id, p]));
    return countChips(rawCounts, (pid) => byId.get(pid)?.nickname ?? "Someone", myPlayerId);
  }, [rawCounts, players, myPlayerId]);

  // Every cell of a sunk ship, not just the one that dealt the final blow, so fire/smoke covers
  // the whole hull instead of a single explosion marker sitting next to intact-looking wreckage.
  // Mapped to orientation so the fire/smoke can be rotated to match the hull it's burning on.
  const defenseSunkCells = sunkCellOrientations(incoming, boardSize);
  const fireSunkCells = sunkCellOrientations(outgoing, boardSize);

  /**
   * What this fleet knows about what is in the water (see lib/deepWater.ts).
   *
   * `deepMarks` is handed this crew's team, which is the whole visibility rule: they see what they
   * found and nothing anybody else found. The exception it makes for itself is Cthulhu awake - four
   * tentacles found by four people who were never told about each other, and then the last one lands
   * and he is on every board in the room at once.
   */
  const deep = useMemo(
    () => deepWater(room, groupIntoShots(attacks, players), deepHides, igonAnchor(room)),
    [room, attacks, players, deepHides]
  );
  /**
   * Every square this crew has fired at, which is what gates the sleeper.
   *
   * Without it, four squares would appear on this board the moment he wakes - including squares this
   * crew has never shot at, which would hand them "there is no hull here" for free. See deepMarks.
   */
  const firedCells = useMemo(() => new Set(outgoing.map((a) => a.cell_index)), [outgoing]);
  const deepCells = useMemo(() => deepMarks(deep, myTeam, firedCells), [deep, myTeam, firedCells]);

  /**
   * Announcing a find, once each.
   *
   * Primed on the first pass exactly as the sfx effect below is, so opening the page mid-match doesn't
   * replay a find from ten minutes ago. Keyed on the whole set of squares rather than a count, because
   * "one more than last render" can't tell a tentacle from the sleeper waking.
   */
  const announced = useRef<Set<string> | null>(null);
  useEffect(() => {
    /**
     * Keyed on the square AND what is on it.
     *
     * When he wakes, up to four squares this crew had already found change from "tentacle" to
     * "sleeper", and that change is the loudest announcement in the match. Keyed on the square alone it
     * would be swallowed as already-seen - and the crew who found all four would be the only people in
     * the room who never heard him.
     */
    const key = (cell: number, kind: DeepMark) => `${cell}:${kind}`;
    const seen = announced.current;
    announced.current = new Set([...deepCells].map(([cell, kind]) => key(cell, kind)));
    if (!seen) return; // first pass primes only

    // One announcement per update, and the waking outranks any find that landed alongside it.
    const fresh = [...deepCells].filter(([cell, kind]) => !seen.has(key(cell, kind)));
    const next = fresh.find(([, kind]) => kind === "sleeper") ?? fresh[0];
    if (!next) return;

    const [cell, kind] = next;
    const where = cellLabel(cell, boardSize);
    const found = [
      deep.whale,
      ...deep.laboon,
      ...deep.cthulhu.tentacles,
      ...deep.dutchman,
      ...deep.bottle,
      // Every crew that found him has an entry on the same square, and `deep` is computed from the
      // public log - so this has to pick OUR crew's, or the toast would name a rival's crewmate for
      // a jar they turned up. deepMarks drew us ours; this names the same one.
      ...deep.alexander.filter((jar) => jar.found.attackerTeam === myTeam).map((jar) => jar.found),
      // Ours, for the same reason as the jar above: every crew that fired at his square has an entry
      // on it, and the toast has to name the crewmate who actually took OUR finger.
      ...deep.igon.filter((ig) => ig.found.attackerTeam === myTeam).map((ig) => ig.found),
      ...deep.patches,
    ].find((f) => f?.cellIndex === cell);
    const mine = found?.playerId === myPlayerId;

    /**
     * Two of these borrow a sound rather than owning one: the ghost ship takes the whale call, since
     * a mournful horn out of the fog is the same register, and Patches takes the tentacle sound
     * because hearing the dread and getting HIM is the entire joke. Alexander plays the same thud
     * whether he is found stuck or shaken loose - one object, two situations.
     */
    if (kind === "whale") {
      playSfx("whale");
      setToast(
        mine
          ? `You found the white whale at ${where}. It did not survive.`
          : `${found?.who} found the white whale at ${where}. Tell nobody.`
      );
    } else if (kind === "laboon") {
      // The same whale call, heard before you can see which whale it was. That is most of the joke.
      playSfx("whale");
      setToast(mine ? `That is Laboon, at ${where}. He is fine.` : `${found?.who} found Laboon at ${where}. He is fine.`);
    } else if (kind === "sleeper") {
      playSfx("awaken");
      setToast("Something enormous has woken up beneath the board.");
    } else if (kind === "dutchman") {
      playSfx("whale");
      const sightings = deep.dutchman.length;
      setToast(
        (mine ? `A sail at ${where}, and nothing under it.` : `${found?.who} sighted the Dutchman at ${where}.`) +
          (sightings > 1 ? ` That is ${sightings} sightings now.` : " She is already gone.")
      );
    } else if (kind === "bottle") {
      playSfx("bottle");
      setToast(
        (mine
          ? `You found a message in a bottle at ${where}! It says `
          : `${found?.who} found a message in a bottle at ${where}! It says `) + `"${bottleNote(room, cell)}"`
      );
    } else if (kind === "jar") {
      playSfx("jar");
      setToast(
        mine
          ? `Something ceramic is wedged in the shallows at ${where}, and it is kicking. Try shooting beside it.`
          : `${found?.who} turned up a warrior jar at ${where}, stuck fast.`
      );
    } else if (kind === "jarFree") {
      playSfx("jar");
      // Credited to whoever fired the shot BESIDE him, not to whoever found him - different people,
      // often enough, and the rescue is the part worth naming. Our crew's jar, for the same reason
      // as above: another crew getting their own copy of him out is not our news.
      const freer = deep.alexander.find((jar) => jar.found.attackerTeam === myTeam)?.freed;
      setToast(
        freer?.playerId === myPlayerId
          ? "You shot Alexander loose. He is delighted, and says you are a Potfriend."
          : `${freer?.who} shot Alexander loose. He is delighted.`
      );
    } else if (kind === "igon") {
      playSfx("igonFinger");
      setToast(
        mine
          ? `Igon is on the rocks at ${where}. He gives you his furled finger - go and kill Bayle with it.`
          : `${found?.who} found Igon at ${where} and was handed his furled finger.`
      );
    } else if (kind === "igonAvenged") {
      playSfx("igonHappy");
      // Credited to whoever fired at BAYLE, not to whoever met him - different people often enough,
      // and the kill is the part worth naming. Our crew's Igon, for the same reason as the jar.
      const avenger = deep.igon.find((ig) => ig.found.attackerTeam === myTeam)?.avenged;
      setToast(
        avenger?.playerId === myPlayerId
          ? "Bayle is dead and you did it with Igon's finger. He shall be tormented no longer."
          : `${avenger?.who} killed Bayle. Igon shall be tormented no longer.`
      );
    } else if (kind === "patches") {
      playSfx("tentacle");
      setToast(
        mine
          ? `You reached for a tentacle at ${where} and got Patches. He is "sorry".`
          : `${found?.who} found Patches at ${where}. He is "sorry".`
      );
    } else {
      playSfx("tentacle");
      const mineCount = [...deepCells.values()].filter((k) => k === "tentacle").length;
      setToast(
        `Something is down there at ${where}` +
          (mineCount > 1 ? ` - that makes ${mineCount} your crew has found.` : ".")
      );
    }
  }, [deepCells, deep, myPlayerId, myTeam, boardSize, room]);

  /**
   * Records this crew is closing on (see lib/recordChase).
   *
   * The book is read once, on mount: it is built from finished matches, so nothing in it can change
   * while this match is running. Scoped to `myTeam`, which is the same rule the water's secrets follow -
   * a crew sees its own chases, and an opponent's run at a record is not their business until the
   * honors go up.
   */
  const [book, setBook] = useState<RecordEntry[]>([]);
  useEffect(() => {
    void (async () => {
      const rows = await fetchParticipants();
      const set = rowSquareSet(room);
      setBook(buildRecordBook(rows.filter((r) => rowSquareSet(r) === set), [], set));
    })();
    // `room.square_set` and not `room`, which is what the comment above always meant by "once".
    // useRoom replaces the room OBJECT on every realtime UPDATE - a pause, a resume, a settings
    // change, the status moving on - so depending on it re-read the entire participation table
    // mid-match, on every player's screen, several times a game. The only thing read out of the
    // room here is which square set to build the book for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.square_set]);

  const chases = useMemo(() => {
    if (book.length === 0) return [];
    const shots = groupIntoShots(attacks, players);
    const userIdFor = (id: string | null) => players.find((p) => p.id === id)?.user_id ?? null;
    return recordChases(book, liveTallies(buildPlayerStats(players, shots), shots, userIdFor), myTeam);
  }, [book, attacks, players, myTeam]);

  // Announced once each, and primed on the first pass so a refresh mid-match doesn't replay a record
  // that fell ten minutes ago.
  const announcedRecords = useRef<Set<string> | null>(null);
  useEffect(() => {
    const broken = chases.filter((c) => c.state === "broken");
    const seen = announcedRecords.current;
    announcedRecords.current = new Set(broken.map((c) => `${c.recordId}-${c.key}`));
    if (!seen) return;

    for (const c of broken) {
      if (seen.has(`${c.recordId}-${c.key}`)) continue;
      playSfx("hit");
      setToast(`${c.nickname} just set a record - ${c.label.toLowerCase()}, ${c.display.split(" - ")[0]}.`);
      break;
    }
  }, [chases]);

  // Squares that can't be hiding anything any more. Only fleets still afloat are considered - a
  // sunk one can't be the reason to keep a square open. See lib/deduction for the rules.
  const liveOpponents = opponentTeams.filter((t) => !eliminated.has(t));
  const autoRuledCells = useMemo(
    () =>
      autoRule ? ruledOutCells({ boardSize, shipDefs, outgoing, opponentTeams: liveOpponents }) : undefined,
    // outgoing and liveOpponents are both derived from these, and rebuilt every render, so the
    // array identities can't be deps without defeating the memo entirely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [autoRule, boardSize, shipDefs, attacks, myTeam, liveOpponents.join(",")]
  );

  // Play sfx + toast for newly-resolved attacks relevant to me (only once each).
  //
  // The first pass only PRIMES the seen-set. Opening the page mid-match hands this the whole
  // attack log at once, and announcing all of it would fire a burst of overlapping sounds for
  // shots that happened minutes ago - a refresh should be silent, not a replay.
  const primed = useRef(false);
  useEffect(() => {
    for (const a of attacks) {
      if (a.result === "pending" || seenResolved.current.has(a.id)) continue;
      if (a.attacker_team !== myTeam && a.defender_team !== myTeam) continue;
      seenResolved.current.add(a.id);
      if (!primed.current) continue;

      const mine = a.attacker_team === myTeam;
      if (a.result === "sunk") {
        playSfx("sunk");
        setToast(
          mine ? `You sank ${teamName(a.defender_team)}'s ${a.sunk_ship_name}!` : `Your ${a.sunk_ship_name} was sunk!`
        );
      } else if (a.result === "hit") {
        playSfx("hit");
        setToast(mine ? `Direct hit on ${teamName(a.defender_team)}!` : "Your fleet took a hit!");
      } else {
        // Incoming misses are announced too. They used to be the one resolved attack that made no
        // sound at all, which is why the board sometimes went quiet while the other fleet was
        // plainly working through squares - their hits and sinkings were audible, their misses
        // (much the commoner outcome) were not.
        playSfx("miss");
        setToast(
          mine ? `Miss on ${teamName(a.defender_team)}.` : `${teamName(a.attacker_team)} missed your fleet.`
        );
      }
    }
    primed.current = true;
  }, [attacks, myTeam]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  // Every square's result in one pass over the log rather than one pass per square - see
  // lib/cellVisuals, which is where that walk and its precedence rules now live for every board.
  const defenseVisuals = useMemo(
    () => cellVisuals(incoming, defenseSunkCells),
    // incoming and defenseSunkCells are both derived from `attacks` and rebuilt every render, so
    // their identities can't be deps without defeating the memo entirely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attacks, myTeam, boardSize]
  );
  const fireVisuals = useMemo(
    () => cellVisuals(outgoing, fireSunkCells),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attacks, myTeam, boardSize]
  );

  // Own ships are drawn as sprite overlays instead of a flat cell colour, so an untouched square
  // on either board is simply empty.
  const myDefenseVisual = (index: number): CellVisual => defenseVisuals.get(index) ?? "empty";
  const fireGridVisual = (index: number): CellVisual => fireVisuals.get(index) ?? "empty";

  const myShipOverlays: ShipOverlay[] = (myFleet.placements ?? []).map((p) => ({
    row: p.startRow,
    col: p.startCol,
    size: shipDefs[p.shipIndex].size,
    horizontal: p.isHorizontal,
    shipName: shipDefs[p.shipIndex].name,
    colorHex: teamHex(myTeam),
  }));

  // Wrecks of enemy ships you've sunk, tinted in their owner's color - revealed via the
  // sunk_* fields on the resolved attack row, never from reading their private fleet.
  const sunkEnemyOverlays: ShipOverlay[] = outgoing
    .filter((a) => a.result === "sunk" && a.sunk_start_row !== null)
    .map((a) => ({
      row: a.sunk_start_row!,
      col: a.sunk_start_col!,
      size: a.sunk_ship_size!,
      horizontal: a.sunk_horizontal!,
      shipName: a.sunk_ship_name!,
      colorHex: teamHex(a.defender_team),
    }));

  async function handleFire(index: number) {
    if (!canFire) return;
    if (outgoing.some((a) => a.cell_index === index)) return;
    if (firedRef.current.has(index)) return;
    firedRef.current.add(index);
    try {
      await sendAttack(room.id, index, myTeam, opponentTeams, myPlayerId);
    } catch (e) {
      firedRef.current.delete(index);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const mySunkCount = myFleet.ship_sunk.filter(Boolean).length;

  const {
    layout,
    setPanel,
    setStack,
    reset: resetLayout,
    enabled: canvasOn,
    setEnabled: setCanvasOn,
    locked,
    setLocked,
  } = useMatchLayout();

  // Canvas pixel size, so stored fractions can be resolved and drag deltas converted back into
  // fractions. Measured rather than assumed: the panel boxes have to keep meaning the same thing
  // when the window is resized mid-match, which is the whole reason they aren't stored in pixels.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 1, h: 1 });

  useEffect(() => {
    const el = canvasRef.current;
    if (!canvasOn || !el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // Guard against 0 - a drag delta divided by a zero canvas is Infinity, which would fling a
      // panel to the clamp boundary on the first pointermove after a hidden/remounted canvas.
      setCanvasSize({ w: Math.max(1, width), h: Math.max(1, height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasOn]);

  /**
   * Everything a CanvasPanel needs that is the same for all of them, keyed off the panel's id.
   *
   * Six panels' worth of box/canvas/onChange/locked/onRestack wiring repeated inline is six places
   * to forget one of them - which in the case of `locked` means a panel that stays draggable after
   * the player locked the layout, and in the case of `onRestack` a panel that silently can't be
   * raised. The title comes from PANEL_TITLES so the panel's name matches the one the layout code
   * uses for it.
   */
  const panelProps = (id: PanelId) => ({
    title: PANEL_TITLES[id],
    box: layout[id],
    canvas: canvasSize,
    onChange: (b: PanelBox) => setPanel(id, b),
    locked,
    onRestack: (to: "front" | "back") => setStack(id, to),
  });

  /** The fire board, shared by both layouts so the two can't drift apart. */
  const fireBoard = (fill: boolean) => (
    <BoardGrid
      boardSize={boardSize}
      cellVisual={fireGridVisual}
      onCellClick={handleFire}
      // The one board where a slipped click costs something that can't be given back. Placement
      // deliberately doesn't get this - a misplaced ship can just be picked up again.
      holdToFireMs={fireHoldMs}
      disabled={!canFire}
      // No caption at all. It carried the countdown once, then just the word "Fire" - which
      // labels the only interactive board on screen with the thing you obviously do to it.
      // The clock and the disabled state already say everything it was saying.
      ships={sunkEnemyOverlays}
      sunkOrientation={fireSunkCells}
      // Only the hunting board carries these. It's the board people are reading squares off, and
      // putting them on a fleet's own board as well would suggest the whale belonged to that fleet's
      // waters - the cell index is shared by both boards, so there is no such thing.
      deepCells={deepCells}
      markedCells={marks}
      onToggleMark={toggleMark}
      autoRuledCells={autoRuledCells}
      counts={countsByCell}
      onCount={bumpCount}
      // Fixed layout subtracts the page chrome this board sits inside: #root's 3.25rem top /
      // 0.75rem bottom padding plus this board's own label and gap. A bare vh number can't do this -
      // 97vh overflowed by ~40px at 1280px tall and by more as the window got shorter, because the
      // chrome is a fixed pixel cost, not a proportion of the viewport. On the canvas none of that
      // applies: the panel is the budget.
      maxVh={fill ? undefined : "calc(100vh - 5.5rem)"}
      maxVw={fill ? undefined : 52}
      fill={fill}
      cellText={(i) => {
        const c = challenges[i];
        if (!c) return null;
        // Cell shows the short form; hover gets the square spelled out - see squareTitle, which
        // settled what that reads like when the board was built.
        return {
          label: c.short ?? c.name,
          title: c.title ?? c.name,
          region: c.region,
          color: c.color,
        };
      }}
    />
  );

  /**
   * The player's own fleet, shared by both layouts for the same reason the fire board is.
   *
   * Its squares are a fraction of the fire board's and already hold a hull, so they can't carry a
   * name - they wear the challenge's colour instead. That is what turns this from a picture of where
   * the ships are into an answer to the question players were actually asking it: which bosses am I
   * sitting on? Match the colour under a hull to the same colour on the fire board (or in the key)
   * and you have it, without reading a single coordinate off either board.
   */
  const fleetBoard = (fill: boolean) => (
    <BoardGrid
      boardSize={boardSize}
      cellVisual={myDefenseVisual}
      label={fill ? undefined : "Your fleet"}
      ships={myShipOverlays}
      sunkOrientation={defenseSunkCells}
      cellTint={(i) => {
        const c = challenges[i];
        if (!c) return null;
        return { region: c.region, color: c.color };
      }}
      maxVh={fill ? undefined : 34}
      maxVw={fill ? undefined : 26}
      fill={fill}
    />
  );

  // One panel for every roster rather than one per team: a 3- or 4-team match would otherwise spawn
  // windows the player never positioned, and a saved layout would stop being valid at a different
  // lobby size.
  const teamBoxes = (
    <>
      <TeamBox
        team={myTeam}
        players={players}
        shipDefs={shipDefs}
        // Straight off our own fleet row, which is already one flag per hull - the authoritative
        // answer for the one fleet this browser is allowed to read in full.
        sunkHulls={myFleet.ship_sunk}
        eliminated={mySunkCount === shipDefs.length}
        isMine
        myPlayerId={myPlayerId}
      />
      {opponentTeams.map((team) => (
        <TeamBox
          key={team}
          team={team}
          players={players}
          shipDefs={shipDefs}
          /*
           * The whole log, not just this crew's `outgoing`.
           *
           * Reading our own shots alone made this the only roster in the app that disagreed with
           * the others: the spectator screen, the caster's crew view and both overlays have always
           * counted every fleet's losses from the full log. In a three-cornered match that meant a
           * rival we had never fired on showed at full strength here while a stream watching the
           * same room showed them half sunk. Two fleets make no difference - every shot at this
           * team is ours - so nothing about a normal match changes.
           */
          sunkHulls={sunkHullFlags(attacks, team, shipDefs)}
          eliminated={eliminated.has(team)}
          myPlayerId={myPlayerId}
        />
      ))}
    </>
  );

  /**
   * Room controls, for the FIXED layout's sidebar only.
   *
   * The canvas doesn't use these - it has MatchDock, which lays the same buttons out along the
   * bottom instead of stacking them down a column. Kept as a column here because the fixed layout
   * still has a sidebar to put them in.
   */
  const controls = (
    <>
      {/* Above the controls, because it is news rather than a button - and it only renders at all
          when somebody on this crew is actually close to a record. */}
      <RecordChases chases={chases} />
      <button
        onClick={() => setAutoRule(!autoRule)}
        style={{ fontSize: "0.78rem", borderColor: autoRule ? "var(--accent)" : undefined }}
        title={AUTO_RULE_HINT}
        aria-pressed={autoRule}
      >
        {autoRule ? "✕ Dead water shown" : "✕ Show dead water"}
      </button>
      {/* Same control as the dock's, because the fixed layout has no dock and this is not a setting
          anyone should have to switch layouts to reach. */}
      <FireHoldSelect value={fireHoldMs} onChange={setFireHoldMs} />
      {/* Same control as the dock's, for the same reason: the fixed layout has no dock, and this is
          not something anyone should have to switch layouts to find. */}
      <AutoFireStatus squareSet={room.square_set} />
      {noteCount > 0 && (
        <button onClick={clearMarks} style={{ fontSize: "0.78rem" }} title={NOTE_HINT}>
          Clear {noteCount} note{noteCount === 1 ? "" : "s"}
        </button>
      )}
      <OverlayLinkBox roomCode={room.code} team={myTeam} rejoinCode={rejoinCode} teams={activeTeamsList} />
      {/* Above "End match" rather than below it, because it is the one people reach for in a hurry
          and the two must never be adjacent enough to misclick: stopping the clock and binning the
          match are a long way apart in consequence. */}
      <PauseControls room={room} players={players} myPlayerId={myPlayerId} isHost={isHost} />
      {isHost && <EndMatchButton roomId={room.id} />}
      <LeaveMatchButton playerId={myPlayerId} roomCode={room.code} />
      {/* Last item in the right-hand column, so it sits bottom-right of the match screen -
          in view for the whole game, which is the point (see MatchInfoBox). */}
      <MatchInfoBox roomCode={room.code} seed={room.seed} rejoinCode={rejoinCode} practice={room.practice} />
    </>
  );

  return (
    <div className="stack" style={{ alignItems: "center", width: "100%" }}>
      {/* Fixed, not in flow - a toast appearing must never shove the board around mid-game. */}
      {toast && (
        <div
          className="panel"
          style={{ position: "fixed", top: "0.75rem", left: "50%", transform: "translateX(-50%)", zIndex: 20 }}
        >
          {toast}
        </div>
      )}

      {/* Also fixed, but centred over the board rather than tucked under the top edge where the
          toast lives: a hit toast is a thing that happened and can be glanced at, this is a thing
          being asked of you. Returns null for the whole of almost every match. */}
      <PauseBanner room={room} players={players} myPlayerId={myPlayerId} isHost={isHost} />
      {error && <div className="error-text">{error}</div>}

      {/* Counters that aren't reaching the database. Worth a line on screen: the numbers still
          appear on your own board either way, so without this a crew has no way to tell that
          nobody else can see them - which is exactly how it went unnoticed. */}
      {countError && (
        <div className="error-text" style={{ fontSize: "0.78rem" }}>
          Square counts aren't saving - your crew can't see them. {countError}
        </div>
      )}

      {/* A host who closes their tab mid-match leaves is_host set on a row nobody is behind, so
          ensure_room_host never promotes anyone and "End match" belongs to a ghost. This is the
          way out, and it has to be reachable from here rather than only from the lobby. */}
      <HostTakeover players={players} onlinePlayerIds={onlinePlayerIds} myPlayerId={myPlayerId} />

      {/* Everyone else has walked out. Shots would silently go nowhere (sendAttack has no one to
          write a row against), so say so rather than leaving someone clicking an inert board. */}
      {opponentTeams.length === 0 && (
        <div className="panel" style={{ borderColor: "var(--accent)", fontSize: "0.85rem" }}>
          Every other fleet has left the room. There's nothing to fire at, so the host can end the match.
        </div>
      )}

      {/* The canvas is the mode; the fixed layout is the option out of it. The button stays because
          the fixed layout is still someone's preference and a bad drag needs an escape hatch that
          isn't a redeploy. Lock is the thing that actually settles a layout: arrange it once, freeze
          it, and stop defending it from stray clicks. */}
      <div className="row" style={{ gap: "0.4rem", alignSelf: "flex-end", marginBottom: "-0.4rem" }}>
        {/* Names the mode it switches TO, so it is styled as an action and carries no accent or
            aria-pressed - see the note on the spectator page's copy of this button. The lock beside
            it is a state, and keeps both. */}
        <button
          onClick={() => setCanvasOn(!canvasOn)}
          style={{ fontSize: "0.72rem", padding: "0.15rem 0.5rem" }}
          title="Drag panels by their title bar; resize from the bottom-right corner"
        >
          {canvasOn ? "Fixed layout" : "Move / resize panels"}
        </button>
        {canvasOn && (
          <>
            {/* The whole point of arranging panels is to stop having to arrange them. Locking is
                what makes a layout something you set once rather than something you defend from
                every stray drag for the rest of the match. */}
            <button
              onClick={() => setLocked(!locked)}
              style={{
                fontSize: "0.72rem",
                padding: "0.15rem 0.5rem",
                borderColor: locked ? "var(--accent)" : undefined,
              }}
              title={
                locked
                  ? "Panels are frozen. Unlock to move, resize or restack them."
                  : "Freeze every panel where it is."
              }
              aria-pressed={locked}
            >
              {locked ? "🔒 Locked" : "🔓 Lock layout"}
            </button>
            {/* Still offered while locked - see the note on reset in useMatchLayout. */}
            <button onClick={resetLayout} style={{ fontSize: "0.72rem", padding: "0.15rem 0.5rem" }}>
              Reset layout
            </button>
          </>
        )}
      </div>

      {canvasOn ? (
        <div className="match-canvas-wrap">
          <div className="match-canvas" ref={canvasRef}>
            <CanvasPanel {...panelProps("board")} flush>
              {fireBoard(true)}
            </CanvasPanel>
            <CanvasPanel {...panelProps("clock")}>
              <MatchClock attacks={attacks} room={room} maxVh={34} maxVw={26} />
              {/* Rides with the clock rather than claiming a panel of its own: it is match state, it
                  is usually absent, and a draggable panel that is empty most of the match is a panel
                  people would close. The fixed layout carries it in the sidebar instead. */}
              <RecordChases chases={chases} />
            </CanvasPanel>
            <CanvasPanel {...panelProps("fleet")} flush>
              {fleetBoard(true)}
            </CanvasPanel>
            <CanvasPanel {...panelProps("log")} flush>
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
            <CanvasPanel {...panelProps("roster")}>
              <div className="stack" style={{ gap: "0.6rem" }}>{teamBoxes}</div>
            </CanvasPanel>
          </div>

          {/* Everything you refer to rather than watch, on one line across the bottom. */}
          <MatchDock
            challenges={challenges}
            squareSet={room.square_set}
            roomId={room.id}
            roomCode={room.code}
            room={room}
            players={players}
            seed={room.seed}
            rejoinCode={rejoinCode}
            myTeam={myTeam}
            myPlayerId={myPlayerId}
            activeTeamsList={activeTeamsList}
            isHost={isHost}
            markCount={noteCount}
            onClearMarks={clearMarks}
            autoRule={autoRule}
            onToggleAutoRule={() => setAutoRule(!autoRule)}
            holdMs={fireHoldMs}
            onChangeHoldMs={setFireHoldMs}
          />
        </div>
      ) : (
      <div
        className="row battle-layout"
        style={{ alignItems: "flex-start", justifyContent: "flex-start", gap: "1.5rem", width: "100%" }}
      >
        {fireBoard(false)}

        {/* Left-aligned, not centered: centering pushed the clock and fleet box toward the right
            edge of this column, where they collided with the fixed top-right toolbar. Aligning to
            the start parks both directly above the Battle Log, which is the first item in the
            split below. */}
        {/* Height is pinned to the same budget as the board so the page itself never scrolls:
            the clock and fleet box are fixed-size, and the split below them is the flex item that
            absorbs whatever is left. minHeight 0 is what allows it to shrink below its content -
            without it a flex item refuses to go under its intrinsic size and pushes the page
            taller instead. Anything that still doesn't fit scrolls inside the sidebar. */}
        <div
          className="stack battle-sidebar"
          style={{
            alignItems: "flex-start",
            gap: "0.75rem",
            flex: 1,
            minWidth: 0,
            height: "calc(100vh - 5.5rem)",
            minHeight: 0,
          }}
        >
          <MatchClock attacks={attacks} room={room} maxVh={34} maxVw={26} />

          {fleetBoard(false)}

          {/* Two side-by-side stacks so neither the log nor the fleet cards leave a tall
              column of dead space beside the board. nowrap + a zero flex-basis is load-bearing:
              `.row` wraps by default, and percentage bases plus the gap overflow the line, which
              silently stacked these vertically instead of splitting them. */}
          <div
            className="battle-sidebar-split"
            style={{
              display: "flex",
              flexWrap: "nowrap",
              alignItems: "stretch",
              gap: "0.75rem",
              width: "100%",
              flex: 1,
              minHeight: 0,
            }}
          >
            <div className="stack" style={{ flex: "1 1 0", minWidth: 0, minHeight: 0 }}>
              {/* 100% rather than a vh figure: the sidebar now has a definite height, so the log
                  fills whatever the clock and fleet box leave behind and scrolls internally. A
                  fixed 52vh was independent of that and could overrun the column. */}
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
            </div>

            {/* Scrolls on its own if the roster plus the host's controls outgrow the column. These
                are buttons somebody needs to reach, so they must never be clipped - but scrolling
                here keeps it out of the page scrollbar, which is the thing we're eliminating. */}
            <div
              className="stack"
              style={{ flex: "1 1 0", minWidth: 0, gap: "0.6rem", overflowY: "auto", minHeight: 0 }}
            >
              {teamBoxes}
              {/* Below the rosters, above the controls: fleet status is what you watch, this is
                  what you refer to. Renders nothing on a square set that tints nothing. */}
              <BoardLegend challenges={challenges} setId={room.square_set} />
              {controls}
            </div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
