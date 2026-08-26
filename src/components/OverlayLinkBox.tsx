import { useState } from "react";
import { teamName, teamHex } from "../lib/teamColors";
import { MIN_OPACITY, MIN_ALERT_SECS, MAX_ALERT_SECS, DEFAULT_ALERT_SECS } from "../lib/overlayCast";
import { TEXT_SIZE_OPTIONS, MIN_TEXT_SIZE, MAX_TEXT_SIZE } from "../lib/overlayText";
import { SourceRow } from "./SourceRow";

interface Props {
  roomCode: string;
  /** Marks this fleet as "yours" in the overlays. Omit for spectators. */
  team?: number | null;
  /**
   * The player's rejoin code, which doubles as the credential a source uses to read its own fleet.
   * Without it, ships can't be offered at all.
   */
  rejoinCode?: string | null;
  /** Every fleet in the room, so the box can offer one set of sources per crew. */
  teams?: number[];
}

/**
 * Who a scene is being built for. A crew, or the desk.
 *
 * One type rather than a team plus an `isCaster` flag, because they are the same choice: every
 * source below is decided by this one value, and two pieces of state that must never both be set
 * is a bug waiting for the one render that sets them both.
 */
type Audience = number | "caster";

/**
 * One setting: what it is, where it stands, and what it changes.
 *
 * All three parts are here rather than left to each caller, because the box's whole failing was
 * that a streamer could not tell its controls apart. A bare track says nothing about what it does,
 * and the value it is at is the first thing you look for after dragging one.
 *
 * `--eb-fill` is the fraction of the track to paint up to the thumb; the styling behind it is in
 * index.css, along with the note on why a range input needs any of this.
 */
function Setting({
  label,
  hint,
  min,
  max,
  step,
  value,
  onChange,
  readout,
}: {
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  readout: string;
}) {
  return (
    <div className="stack" style={{ gap: "0.25rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
        <span style={{ fontSize: "0.78rem" }}>{label}</span>
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          {readout}
        </span>
      </div>
      <input
        type="range"
        className="eb-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        style={{ ["--eb-fill" as string]: (value - min) / (max - min) }}
      />
      <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
        {hint}
      </span>
    </div>
  );
}

/**
 * A text size, named.
 *
 * The named steps were the whole control once and are now the readout, which is the job they were
 * always best at: nobody needs "1.25" as a number, they need to know that where they have dragged
 * to is the one that is comfortable on a 1080p stream. The nearest step wins, so the name changes
 * as you drag past it rather than blinking out between the round values.
 */
function textReadout(value: number): string {
  const nearest = TEXT_SIZE_OPTIONS.reduce((best, o) =>
    Math.abs(o.value - value) < Math.abs(best.value - value) ? o : best
  );
  return `${value.toFixed(2).replace(/0+$/, "").replace(/.$/, "")}x - ${nearest.label}`;
}

/**
 * The OBS sources, chosen by WHO IS STREAMING rather than by what each source does.
 *
 * -- Why this is a role picker and not a form -----------------------------------------------------
 *
 * It used to be one flat list of six sources with the decisions spread across it: which fleet's
 * board, ships on or off, a note on the clock row saying you could type ?odds=1 onto it. Every one
 * of those was the same question in another costume - what am I, a player or a caster? - and the
 * box made a streamer answer it once per row, in the vocabulary of the source rather than their
 * own. A player setting up at 3am had to know that "the board" meant the board of shots fired AT
 * them, that their own hunting board wasn't on the list at all, and that the odds bar sitting in
 * the middle of it was not for them.
 *
 * So the question is asked once, at the top, and the list answers it. A crew gets the two boards
 * they already play off and nothing they would have to think about; the desk gets the boards it
 * drives and the numbers it reads. Nobody is offered a source that would be wrong for them.
 *
 * -- The odds -------------------------------------------------------------------------------------
 *
 * The win-probability bar is a caster's instrument. It is an evaluation bar: a player who can see
 * their own odds swing mid-match is being told something about the shape of the board that the
 * match is supposed to make them work out. So it is on the caster's clock and is not offered to a
 * crew at all.
 *
 * Said plainly because it cannot be enforced and pretending otherwise would be worse: the model
 * runs on the public attack log in the viewer's own browser (see lib/victoryOdds), so there is
 * nothing to authenticate against and never was. Keeping it off the player list is a matter of not
 * handing somebody a loaded gun, not of locking the armoury.
 *
 * -- Why this is worth opening in the LOBBY -------------------------------------------------------
 *
 * A stream scene gets built before the match, not during it, so this has to work in a lobby: one
 * fleet in the room, or none picked yet, and it still has to name the sources. Hence the audience
 * following your fleet until you overrule it - opening this, then picking Blue, then finding your
 * sources still aimed at nobody is a trap that only springs on stream.
 *
 * Built from window.location so the URLs stay correct on localhost, on GitHub Pages under its
 * /Elden-Battleship/ base, and anywhere else it gets hosted - hardcoding the deployed origin would
 * hand every local tester a link pointing at production.
 */
export function OverlayLinkBox({ roomCode, team, rejoinCode, teams }: Props) {
  const [open, setOpen] = useState(false);
  /**
   * Who this scene is for, once they've said.
   *
   * `undefined` means they haven't. Until then the box follows whichever fleet they joined, so the
   * lobby order everybody actually uses - open this, then pick a colour - lands on their own crew.
   */
  const [picked, setPicked] = useState<Audience | undefined>(undefined);
  /** How solid the scene is on stream. One setting, written into every source that draws. */
  const [opacity, setOpacity] = useState(1);
  /**
   * How solid a square nobody has fired at is - see readEmptyFade.
   *
   * Starts at 1, which is the board exactly as it was before this existed. A default that quietly
   * thinned every player's board would be this box making a decision about their scene that they
   * did not ask it to make; the slider is there to be found, and the label says what it does.
   */
  const [emptyFade, setEmptyFade] = useState(1);
  /** How long the find alert holds a find. */
  const [alertSecs, setAlertSecs] = useState(DEFAULT_ALERT_SECS);
  /**
   * How large the text is on stream. One setting, written into every source that draws text - same
   * reasoning as the transparency slider below it, spelled out in lib/overlayText.
   */
  const [textSize, setTextSize] = useState(1);

  const myTeam = team !== null && team !== undefined ? team : null;
  const audience: Audience | undefined = picked !== undefined ? picked : myTeam ?? undefined;
  const isCaster = audience === "caster";
  /** The crew this scene is for, or null at the desk. */
  const crew = typeof audience === "number" ? audience : null;
  /** Your own fleet can only be drawn with your own rejoin code, and only on your own board. */
  const canDrawFleet = Boolean(rejoinCode) && myTeam !== null && crew === myTeam;

  /**
   * The fleets this box can build a scene for: everyone in the room, plus your own.
   *
   * Your own is unioned in rather than assumed present because `teams` is the fleets that have
   * players, and in a lobby you may be the only one in it - the list would otherwise be missing the
   * one entry that matters to the person reading it.
   */
  const crewOptions = Array.from(new Set([...(teams ?? []), ...(myTeam !== null ? [myTeam] : [])])).sort(
    (a, b) => a - b
  );

  const base = `${window.location.origin}${window.location.pathname}`;

  /**
   * The two settings every drawing source shares, appended last.
   *
   * Only written when they are actually doing something - a URL full of defaults is harder to read,
   * and harder to hand-edit afterwards, which is the escape hatch for anyone who wants one source
   * to differ from the rest.
   */
  const withScene = (q: URLSearchParams) => {
    if (opacity < 1) q.set("opacity", opacity.toFixed(2));
    if (textSize !== 1) q.set("text", String(textSize));
    return q.toString();
  };
  const url = (route: string, qs: string) => `${base}#/${route}/${roomCode}${qs ? `?${qs}` : ""}`;

  /**
   * The crew's hunting board: their own shots, on the board they play off. See the ?fire= note in
   * pages/OverlayBoard.
   *
   * No rejoin code goes anywhere near it. Which squares a fleet has fired at, and what came back,
   * is in the public attack log already - so this source works the moment it is pasted in, and a
   * player who hands the URL to a co-streamer has handed over nothing they didn't have.
   */
  const fireQuery = new URLSearchParams();
  if (crew !== null) {
    fireQuery.set("team", String(crew));
    fireQuery.set("fire", "1");
  }
  // The crew's own board is the one place the unfired-square setting means anything - see the
  // Setting for it below, and readEmptyFade for why a caster's board never takes one.
  if (emptyFade < 1) fireQuery.set("empty", emptyFade.toFixed(2));
  const fireUrl = url("overlay-board", withScene(fireQuery));

  /**
   * The caster's board: no parameters at all.
   *
   * That is what puts it under the control page rather than pinning it - see pinnedView. The scene
   * settings are deliberately left off for the same reason: transparency and text size are two of
   * the sliders on the desk, and writing them into the URL would pin the board and disconnect the
   * very page the caster is about to drive it from.
   */
  const casterBoardUrl = url("overlay-board", "");

  /**
   * Every fleet's shots on one board, pinned - a board with nobody driving it.
   *
   * `pin=1` rather than an empty query is the whole point: no parameters at all is the CASTER's
   * board, waiting to be aimed, and "all fleets, unattended" is the opposite intention expressed in
   * the same characters. See pinnedView.
   *
   * For a scene with no desk behind it - a co-stream, a second monitor, a room left running on a
   * screen at an event. It takes the scene settings for the same reason: nothing else is going to
   * tell it how solid to be.
   */
  const allFleetsQuery = new URLSearchParams();
  allFleetsQuery.set("pin", "1");
  const allFleetsUrl = url("overlay-board", withScene(allFleetsQuery));

  /**
   * The player's own fleet panel - the small board from their play screen, hulls and all.
   *
   * `text` is dropped from the scene settings on purpose. This source has no text in it to size: it
   * trades square names for square colours, which is the whole reason it exists. See
   * pages/OverlayFleet.
   */
  const fleetQuery = new URLSearchParams();
  if (canDrawFleet) fleetQuery.set("key", rejoinCode!);
  if (opacity < 1) fleetQuery.set("opacity", opacity.toFixed(2));
  if (emptyFade < 1) fleetQuery.set("empty", emptyFade.toFixed(2));
  const fleetUrl = url("overlay-fleet", fleetQuery.toString());

  /**
   * Two clocks, and the only difference between them is the odds band.
   *
   * A player's carries their fleet, which is what marks their own hulls out in the row of them.
   * A caster's carries `odds=1` and no fleet: the odds are a statement about the whole room, and
   * highlighting one crew inside them would be the beginning of an argument about which number the
   * source is really for.
   */
  const clockQuery = new URLSearchParams();
  if (crew !== null) clockQuery.set("team", String(crew));
  else clockQuery.set("odds", "1");
  const clockUrl = url("overlay-timer", withScene(clockQuery));

  const keyUrl = url("overlay-key", withScene(new URLSearchParams()));

  /**
   * The board's sound, with no picture attached - see pages/OverlayAudio.
   *
   * Takes the crew only to decide which sting plays at the end, so the desk's copy carries none:
   * a caster has no side to be cheered for.
   *
   * Neither scene setting applies, so neither is written: `opacity` is about a picture this source
   * hasn't got, and `text` is about names it never draws.
   *
   * Nor is a volume, though the page will read a `?vol=` if one is typed. Level is the one thing OBS
   * itself does better than a URL - tick "Control audio via OBS" and the source gets a fader and a
   * mute button that can be ridden mid-match - and a number baked into the link would be a second
   * volume control that the fader silently overrules. Better to ship no opinion and let the mixer
   * hold the only one.
   */
  const audioQuery = new URLSearchParams();
  if (crew !== null) audioQuery.set("team", String(crew));
  const audioUrl = url("overlay-audio", audioQuery.toString());

  /**
   * The find alert - see pages/OverlayEgg.
   *
   * On both lists, and identical on both. What the water gives up belongs to the room rather than
   * to a fleet: the board already draws every crew's finds and the audio source already plays them,
   * so an alert that differed by audience would be the one thing on the stream disagreeing with the
   * other two about what just happened.
   *
   * No text size - the caption sizes itself off the source, which is the only measurement that
   * means anything for a box this is dropped into. Opacity applies like anywhere else.
   */
  const eggQuery = new URLSearchParams();
  if (opacity < 1) eggQuery.set("opacity", opacity.toFixed(2));
  if (alertSecs !== DEFAULT_ALERT_SECS) eggQuery.set("secs", String(alertSecs));
  const eggUrl = url("overlay-egg", eggQuery.toString());

  const castUrl = url("cast", "");

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ fontSize: "0.8rem" }} title="Get stream overlay URLs for OBS">
        Stream overlay
      </button>
    );
  }

  return (
    <div className="panel stack" style={{ gap: "0.5rem", padding: "0.6rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
        <strong style={{ fontSize: "0.82rem" }}>OBS sources</strong>
        <button onClick={() => setOpen(false)} style={{ padding: "0.1rem 0.4rem", fontSize: "0.75rem" }}>
          Close
        </button>
      </div>

      <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
        Add each as a <strong>Browser Source</strong> in OBS at the size shown, and tick{" "}
        <em>Shutdown source when not visible</em>. Backgrounds are transparent.
      </span>

      {/*
        The one question, asked once. Everything below is its answer - see the role-picker note at
        the top of the file. Shown whatever the room looks like, including a room containing only
        you: see crewOptions and the lobby paragraph.
      */}
      <div className="stack" style={{ gap: "0.25rem" }}>
        <span style={{ fontSize: "0.78rem" }}>Who's streaming?</span>
        <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
          {crewOptions.map((t) => (
            <button
              key={t}
              onClick={() => setPicked(t)}
              style={{
                fontSize: "0.74rem",
                color: teamHex(t),
                borderColor: audience === t ? "var(--accent)" : undefined,
              }}
            >
              {t === myTeam ? `${teamName(t)} (you)` : teamName(t)}
            </button>
          ))}
          <button
            onClick={() => setPicked("caster")}
            style={{ fontSize: "0.74rem", borderColor: isCaster ? "var(--accent)" : undefined }}
          >
            Caster
          </button>
        </div>
        <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
          {isCaster
            ? "The desk: a board you aim from the control page, and the clock with the odds bar in it."
            : "A crew's own scene - the two boards they're playing off, and nothing they'd have to think about."}
        </span>
      </div>

      {/* A spectator who hasn't said which scene they're building. Offering them one crew's sources
          at random would be worse than offering none. */}
      {audience === undefined ? (
        <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
          Pick a fleet above - or <em>Caster</em> - and the sources for it appear here. Joining a
          fleet in the lobby picks it for you.
        </span>
      ) : (
        <>
          {/*
            Every adjustable thing about these sources, as sliders that say what they do.

            The sizes and the transparency used to be two different KINDS of control - a slider for
            one, named buttons for the other - on the theory that legibility is a handful of
            distinct situations rather than a continuum. In front of a streamer that distinction is
            invisible: they are all just "settings for my overlay", and having two of them behave
            differently only made the box harder to read. The named steps survive where they were
            actually useful, in the readout, which says which one you have landed on and what it is
            for as you drag past it.

            Each carries its own label, its own readout and a line saying what it changes, because
            the alternative is a row of unmarked tracks and a streamer guessing which is which at
            3am. See .eb-slider in index.css for why they are styled rather than left native - a
            slider you cannot drag to either end is a slider that lies about its own range.
          */}
          <Setting
            label="Overlay transparency"
            hint="How much of your gameplay shows through the whole scene. On the boards it's the water that fades: square names and shots hold back about halfway to solid, and the frame and grid lines barely move."
            min={MIN_OPACITY}
            max={1}
            step={0.05}
            value={opacity}
            onChange={setOpacity}
            readout={opacity >= 1 ? "solid" : opacity <= 0 ? "hidden" : `${Math.round(opacity * 100)}%`}
          />

          {/* Crews only. A caster is reading the whole board and needs the squares nobody has fired
              at yet to still be squares - it is the empty water they are looking for patterns in.
              A player already knows where they have been, so the fill is just something between
              them and their own footage. */}
          {!isCaster && (
            <Setting
              label="Unfired squares"
              hint="How solid a square you haven't shot at yet is. Turn it down and your own gameplay shows through everywhere you haven't been, while hits, misses and wrecks stay as solid as ever."
              min={0}
              max={1}
              step={0.05}
              value={emptyFade}
              onChange={setEmptyFade}
              readout={
                emptyFade >= 1
                  ? "same as the rest"
                  : emptyFade <= 0
                    ? "no fill at all"
                    : `${Math.round(emptyFade * 100)}%`
              }
            />
          )}

          <Setting
            label="Text size"
            hint="Square names, coordinates, the clock and the key together. Text never overflows: a size that doesn't fit draws as large as it can."
            min={MIN_TEXT_SIZE}
            max={MAX_TEXT_SIZE}
            step={0.05}
            value={textSize}
            onChange={setTextSize}
            readout={textReadout(textSize)}
          />

          <Setting
            label="Find alert time"
            hint="How long the Finds source holds a find on screen before it goes back to drawing nothing."
            min={MIN_ALERT_SECS}
            max={MAX_ALERT_SECS}
            step={1}
            value={alertSecs}
            onChange={setAlertSecs}
            readout={`${alertSecs}s`}
          />

          {/* The Board is the exception to all of the above, and only for a caster: it takes these
              live off the control page, and writing them into its URL would PIN it and disconnect
              the very desk the caster is about to drive it from. See the casterBoardUrl note. */}
          {isCaster && (
            <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
              These apply to the clock, the key and the alert. The Board takes its transparency,
              text size, zoom and framing from the control page instead - set them there, mid-match,
              with the board in front of you.
            </span>
          )}

          {isCaster ? (
            <>
              <SourceRow
                label="Board"
                url={casterBoardUrl}
                size="1000 x 1000"
                note="the board you aim from the control page - zoom, pan and spotlight"
              />
              {/* Second, and deliberately after the one this page drives: a desk that wants a board
                  wants the controllable one, and this is for the scene that has no desk. */}
              <SourceRow
                label="All fleets"
                url={allFleetsUrl}
                size="1000 x 1000"
                note="every fleet's shots on one board, with nobody driving it - no control page needed"
              />
              <SourceRow
                label="Caster clock"
                url={clockUrl}
                size="1200 x 300"
                note="the match clock, every fleet's hulls, and the odds bar under it"
              />
              <SourceRow
                label="Key"
                url={keyUrl}
                size="1920 x 90"
                note="a thin strip for the bottom edge - add ?plate=0 for no backing"
              />
              <SourceRow
                label="Audio"
                url={audioUrl}
                size="100 x 100"
                note="the board's sound - no picture. Tick 'Control audio via OBS' for its own fader"
              />

              <SourceRow
                label="Finds"
                url={eggUrl}
                size="600 x 600"
                note="empty until the water gives something up, then the find for a few seconds - add ?secs=8 to hold it longer"
              />

              {/* Not a browser source, and listed apart so nobody pastes it into OBS. */}
              <div className="stack" style={{ gap: "0.15rem" }}>
                <span style={{ fontSize: "0.78rem" }}>Control page</span>
                <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
                  Open <a href={castUrl}>{castUrl}</a> in a normal browser window - not in OBS. It
                  drives the Board source above: zoom, pan, spotlight, which fleets' markers show,
                  and the transparency and text size for the scene.
                </span>
              </div>

              <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
                The odds bar is a caster's instrument, so it's on this clock and not on a crew's. It
                runs on the public shot log in the browser, so it isn't locked to this page - it's
                simply not something to put in front of somebody who's still playing.
              </span>
            </>
          ) : (
            <>
              {/* First, because it is the board the player is actually looking at. */}
              <SourceRow
                label="Fire board"
                url={fireUrl}
                size="1000 x 1000"
                note={`${teamName(crew!)}'s own shots - the board they're playing off`}
              />

              {canDrawFleet ? (
                <SourceRow
                  label="Your fleet"
                  url={fleetUrl}
                  size="400 x 400"
                  note="your ships and the damage they've taken - the small board from your screen"
                />
              ) : (
                <div className="stack" style={{ gap: "0.15rem" }}>
                  <span style={{ fontSize: "0.78rem" }}>Your fleet</span>
                  <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
                    {myTeam === null
                      ? "Only the crew themselves can put this on stream - it's drawn with their rejoin code, from this page, while they're on the fleet."
                      : `You're on ${teamName(myTeam)}, so this is the one source you can't build for ${teamName(crew!)}. Pick your own fleet above to get it.`}
                  </span>
                </div>
              )}

              {/* The warning belongs on the row, not on a toggle three rows up: the decision is made
                  at the moment the URL is copied, and that is the moment it has to be readable. */}
              {canDrawFleet && (
                <span style={{ fontSize: "0.68rem", lineHeight: 1.35, color: "var(--hit)" }}>
                  <strong>
                    The Fleet URL draws your ships and carries your rejoin code. Put it on stream
                    only if you want viewers to see where your hulls are, and share it with nobody.
                  </strong>
                </span>
              )}

              <SourceRow
                label="Clock"
                url={clockUrl}
                size="1200 x 200"
                note="the match clock and every fleet's hulls, with yours marked"
              />
              <SourceRow
                label="Key"
                url={keyUrl}
                size="1920 x 90"
                note="a thin strip for the bottom edge - add ?plate=0 for no backing"
              />

              <SourceRow
                label="Finds"
                url={eggUrl}
                size="600 x 600"
                note="empty until the water gives something up, then the find for a few seconds - add ?secs=8 to hold it longer"
              />

              {/* The one source with nothing to look at, so the size is a formality and the note has
                  to do the whole job of saying what it is. Listed last for the same reason: it is
                  the only one whose placement in the scene doesn't matter. */}
              <SourceRow
                label="Audio"
                url={audioUrl}
                size="100 x 100"
                note="the board's sound - no picture. Tick 'Control audio via OBS' for its own fader"
              />
            </>
          )}

          {/* Said here because the alternative is a streamer discovering it live and assuming their
              source is broken. See lib/overlayReveal.ts. */}
          <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
            Square names, square colours and the colour key stay blank until the match starts, so
            nobody can read the board during placement. That includes you.
          </span>
        </>
      )}
    </div>
  );
}
