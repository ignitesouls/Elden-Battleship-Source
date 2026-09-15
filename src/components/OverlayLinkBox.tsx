import { useEffect, useState } from "react";
import { useT } from "../lib/language";
import { teamName, teamHex } from "../lib/teamColors";
import { MIN_OPACITY, MIN_ALERT_SECS, MAX_ALERT_SECS, DEFAULT_ALERT_SECS } from "../lib/overlayCast";
import { MIN_TEXT_SIZE, MAX_TEXT_SIZE } from "../lib/overlayText";
import { MAX_LAP, MAX_SPOT } from "../lib/overlayCamera";
import { SourceRow } from "./SourceRow";
// Lifted out when the OBS setup page grew the same four sliders - see components/OverlaySetting.
import { OverlaySetting as Setting, textReadout } from "./OverlaySetting";
import { OverlaySample } from "./OverlaySample";
import type { DeepMark } from "../lib/deepWater";

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
  const t = useT();
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
   * The two ways a crew's board can aim itself, both off by default. Seconds, and 0 means off.
   *
   * Off is the right default even though the moving board is more readable, because this is a
   * source somebody has already placed in a scene: a board that started panning on its own after an
   * update would be a change to a stream its owner had already framed and approved. It is offered,
   * not applied. See lib/overlayCamera.
   */
  const [lapSecs, setLapSecs] = useState(0);
  const [spotSecs, setSpotSecs] = useState(0);
  /**
   * A find held over the preview, while the streamer is looking at it.
   *
   * The one setting with nothing to show for itself: every other slider changes a picture that is
   * already on screen, and this one changes a number of seconds. So it gets a button that plays one,
   * which is also the only way to see how large the card is against the board it will sit next to.
   */
  const [playing, setPlaying] = useState<DeepMark | null>(null);
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setPlaying(null), alertSecs * 1000);
    return () => clearTimeout(t);
  }, [playing, alertSecs]);
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
  /**
   * The self-aiming camera, on the crew's own board and nowhere else in this box.
   *
   * The caster's board is left out on purpose, and not because it can't: it takes the same camera
   * off the control page's Auto-pilot switch, which is where a caster can also take the wheel back
   * mid-lap. Writing it into their URL would PIN the source and disconnect the very desk they were
   * about to drive it from - the same trap the transparency and text sliders are kept away from it
   * for. See casterBoardUrl.
   */
  if (lapSecs > 0) {
    fireQuery.set("autopan", "1");
    fireQuery.set("lap", String(lapSecs));
  }
  if (spotSecs > 0) fireQuery.set("spotlight", String(spotSecs));
  const fireUrl = url("overlay-board", withScene(fireQuery));

  /**
   * The same hunting board, small: colours instead of names, and no text on it at all. See the
   * `mini` block in pages/OverlayBoard.
   *
   * Three of this box's settings are deliberately absent from it. `text` because there is none to
   * size - that is the whole trade the source makes. Auto-pan and the spotlight because a board
   * this size is a picture parked in a corner, not a stage: it has nothing to zoom into, and a
   * 400px source walking its own quadrants would be motion in the corner of somebody's footage
   * with no legibility bought by it.
   */
  const fireMiniQuery = new URLSearchParams();
  if (crew !== null) {
    fireMiniQuery.set("team", String(crew));
    fireMiniQuery.set("fire", "1");
  }
  fireMiniQuery.set("mini", "1");
  if (opacity < 1) fireMiniQuery.set("opacity", opacity.toFixed(2));
  if (emptyFade < 1) fireMiniQuery.set("empty", emptyFade.toFixed(2));
  const fireMiniUrl = url("overlay-board", fireMiniQuery.toString());

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
   *
   * `?deep=0` is the other thing it will read and the other thing this box declines to write: it
   * silences the finds and leaves the shots, which is a call about what the broadcast is FOR rather
   * than a setting with a right answer, and the default here has to be the one that makes the source
   * worth adding. A desk that wants it types it; see pages/OverlayAudio, and the top bar's own
   * toggle for the tab version of the same choice.
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
      <button
        onClick={() => setOpen(true)}
        style={{ fontSize: "0.8rem" }}
        title={t("Get stream overlay URLs for OBS", "Obtenir les URL de superposition pour OBS")}
      >
        {t("Stream overlay", "Superposition de stream")}
      </button>
    );
  }

  return (
    <div className="panel stack" style={{ gap: "0.5rem", padding: "0.6rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
        <strong style={{ fontSize: "0.82rem" }}>{t("OBS sources", "Sources OBS")}</strong>
        <button onClick={() => setOpen(false)} style={{ padding: "0.1rem 0.4rem", fontSize: "0.75rem" }}>
          {t("Close", "Fermer")}
        </button>
      </div>

      <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
        {t("Add each as a", "Ajoutez chacune comme une")} <strong>{t("Browser Source", "source navigateur")}</strong>{" "}
        {t("in OBS at the size shown, and tick", "dans OBS, à la taille indiquée, et cochez")}{" "}
        <em>{t("Shutdown source when not visible", "Arrêter la source quand elle n'est pas visible")}</em>.{" "}
        {t("Backgrounds are transparent.", "Les arrière-plans sont transparents.")}
      </span>

      {/*
        Said at the top rather than at the bottom, because by the time somebody has copied the first
        URL out of this box they have already committed to doing it the long way - and they will do
        it again before the next match, and the one after that.

        These URLs are not going anywhere. They name a room, which is exactly right for a one-off: a
        co-stream of somebody else's match, an event screen, a scene built for one tournament. The
        persistent version is the answer to the other case, which is most people most of the time.
      */}
      <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
        {t("These name", "Celles-ci nomment")} <strong>{t("this room", "cette partie")}</strong>
        {t(
          ", so you'd paste them in again next match. For a scene you install once and never touch, see",
          ", donc vous devrez les recoller au prochain match. Pour une scène installée une fois pour toutes, voyez"
        )}{" "}
        <a href="#/streaming" target="_blank" rel="noreferrer">
          {t("OBS & auto-marking", "OBS et marquage auto")}
        </a>{" "}
        {t(
          "- it downloads a whole OBS scene whose sources follow you from match to match. (Opens in a new tab, so it can't cost you this one.)",
          "- ça télécharge une scène OBS entière dont les sources vous suivent de match en match. (S'ouvre dans un nouvel onglet, donc ça ne peut pas vous coûter celui-ci.)"
        )}
      </span>

      {/*
        The one question, asked once. Everything below is its answer - see the role-picker note at
        the top of the file. Shown whatever the room looks like, including a room containing only
        you: see crewOptions and the lobby paragraph.
      */}
      <div className="stack" style={{ gap: "0.25rem" }}>
        <span style={{ fontSize: "0.78rem" }}>{t("Who's streaming?", "Qui est en stream ?")}</span>
        <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
          {crewOptions.map((ct) => (
            <button
              key={ct}
              onClick={() => setPicked(ct)}
              style={{
                fontSize: "0.74rem",
                color: teamHex(ct),
                borderColor: audience === ct ? "var(--accent)" : undefined,
              }}
            >
              {ct === myTeam ? `${teamName(ct)} ${t("(you)", "(vous)")}` : teamName(ct)}
            </button>
          ))}
          <button
            onClick={() => setPicked("caster")}
            style={{ fontSize: "0.74rem", borderColor: isCaster ? "var(--accent)" : undefined }}
          >
            {t("Caster", "Présentateur")}
          </button>
        </div>
        <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
          {isCaster
            ? t(
                "The desk: a board you aim from the control page, and the clock with the odds bar in it.",
                "Le poste : un plateau que vous visez depuis la page de contrôle, et l'horloge avec la barre de cotes."
              )
            : t(
                "A crew's own scene - the two boards they're playing off, and nothing they'd have to think about.",
                "La scène d'une équipe - les deux plateaux sur lesquels elle joue, et rien d'autre à se soucier."
              )}
        </span>
      </div>

      {/* A spectator who hasn't said which scene they're building. Offering them one crew's sources
          at random would be worse than offering none. */}
      {audience === undefined ? (
        <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
          {t("Pick a fleet above - or", "Choisissez une flotte ci-dessus - ou")} <em>{t("Caster", "Présentateur")}</em>{" "}
          {t(
            "- and the sources for it appear here. Joining a fleet in the lobby picks it for you.",
            "- et les sources correspondantes apparaissent ici. Rejoindre une flotte dans le lobby la choisit pour vous."
          )}
        </span>
      ) : (
        <>
          {/*
            The sample, and the sliders under it.

            A streamer used to have to paste a URL into OBS, look at it, come back, drag something,
            and look again - and the settings that most need that loop are the ones about legibility
            over their own footage, which is the one thing the loop cannot show them either, because
            by then they are looking at the overlay in isolation. So the sample sits above the
            sliders and moves as they do.

            It is not a picture OF the sources. It is the same BoardGrid wearing the same classes and
            reading the same variables - see OverlaySample, which is deliberately built so there is no
            second implementation here to drift.
          */}
          <OverlaySample
            opacity={opacity}
            emptyFade={isCaster ? 1 : emptyFade}
            textSize={textSize}
            alertMark={playing}
            isCaster={isCaster}
          />

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
            label={t("Overlay transparency", "Transparence de la superposition")}
            hint={t(
              "How much of your gameplay shows through the whole scene. On the boards it's the water that fades: square names and shots hold back about halfway to solid, and the frame and grid lines barely move.",
              "La part de votre jeu qui transparaît dans toute la scène. Sur les plateaux, c'est l'eau qui s'efface : les noms de cases et les tirs restent environ à mi-chemin du plein, et le cadre et les lignes de grille bougent à peine."
            )}
            min={MIN_OPACITY}
            max={1}
            step={0.05}
            value={opacity}
            onChange={setOpacity}
            readout={
              opacity >= 1
                ? t("solid", "plein")
                : opacity <= 0
                  ? t("hidden", "invisible")
                  : `${Math.round(opacity * 100)}%`
            }
          />

          {/* Crews only. A caster is reading the whole board and needs the squares nobody has fired
              at yet to still be squares - it is the empty water they are looking for patterns in.
              A player already knows where they have been, so the fill is just something between
              them and their own footage. */}
          {!isCaster && (
            <Setting
              label={t("Unfired squares", "Cases non tirées")}
              hint={t(
                "How solid a square you haven't shot at yet is. Turn it down and your own gameplay shows through everywhere you haven't been, while hits, misses and wrecks stay as solid as ever.",
                "À quel point une case où vous n'avez pas encore tiré est pleine. Baissez-la et votre propre jeu transparaît partout où vous n'êtes pas allé, tandis que les touchés, ratés et épaves restent aussi pleins qu'avant."
              )}
              min={0}
              max={1}
              step={0.05}
              value={emptyFade}
              onChange={setEmptyFade}
              readout={
                emptyFade >= 1
                  ? t("same as the rest", "comme le reste")
                  : emptyFade <= 0
                    ? t("no fill at all", "aucun remplissage")
                    : `${Math.round(emptyFade * 100)}%`
              }
            />
          )}

          {/* Crews only, like the fade above it, and for a related reason: it writes itself into
              the Fire board's URL, and the only board in the caster's list that a URL may safely
              pin is the unattended one. A caster gets the same camera as a switch on their control
              page, where it can be handed back mid-sentence. */}
          {!isCaster && (
            <>
              <Setting
                label={t("Auto-pan", "Panoramique auto")}
                hint={t(
                  "Zooms to 2x and walks the four quadrants clockwise, holding still on each one long enough to read it. A whole board at stream resolution is names nobody can make out; a quarter of it is legible, and this is how the other three quarters still get seen.",
                  "Zoome à 2x et parcourt les quatre quadrants dans le sens horaire, s'arrêtant sur chacun assez longtemps pour le lire. Un plateau entier à la résolution du stream, c'est des noms illisibles ; un quart est lisible, et c'est comme ça que les trois autres quarts sont vus aussi."
                )}
                min={0}
                max={MAX_LAP}
                step={40}
                value={lapSecs}
                onChange={setLapSecs}
                readout={
                  lapSecs === 0
                    ? t("off", "désactivé")
                    : `${Math.floor(lapSecs / 60)}:${String(lapSecs % 60).padStart(2, "0")} ${t("a lap", "par tour")}`
                }
              />
              <Setting
                label={t("Spotlight new squares", "Éclairer les nouvelles cases")}
                hint={t(
                  "Each square you mark takes the camera for this long, ringed in white. With auto-pan on it only moves as far as that square's quadrant and the lap carries on from there, so a busy exchange doesn't throw your viewers around the board.",
                  "Chaque case que vous marquez prend la caméra pendant ce temps, entourée de blanc. Avec le panoramique auto activé, elle ne se déplace que jusqu'au quadrant de cette case et le tour reprend de là, pour qu'un échange animé ne balade pas vos spectateurs sur le plateau."
                )}
                min={0}
                max={MAX_SPOT}
                step={2}
                value={spotSecs}
                onChange={setSpotSecs}
                readout={spotSecs === 0 ? t("off", "désactivé") : `${spotSecs}s`}
              />
            </>
          )}

          <Setting
            label={t("Text size", "Taille du texte")}
            hint={t(
              "How much of each square its name fills, plus the clock and the key. The A-J and 1-10 labels aren't touched - they're sized by the board, so they grow when you zoom rather than when you drag this. Text never overflows: a size that doesn't fit draws as large as it can.",
              "La part de chaque case que son nom remplit, plus l'horloge et la légende. Les repères A-J et 1-10 ne sont pas affectés - ils sont dimensionnés par le plateau, donc ils grandissent au zoom plutôt qu'avec ce réglage. Le texte ne dépasse jamais : une taille qui ne rentre pas se dessine aussi grande que possible."
            )}
            min={MIN_TEXT_SIZE}
            max={MAX_TEXT_SIZE}
            step={0.05}
            value={textSize}
            onChange={setTextSize}
            readout={textReadout(textSize)}
          />

          <Setting
            label={t("Find alert time", "Durée d'alerte de découverte")}
            hint={t(
              "How long the Finds source holds a find on screen before it goes back to drawing nothing.",
              "Combien de temps la source Finds garde une découverte à l'écran avant de redessiner le vide."
            )}
            min={MIN_ALERT_SECS}
            max={MAX_ALERT_SECS}
            step={1}
            value={alertSecs}
            onChange={setAlertSecs}
            readout={`${alertSecs}s`}
          />

          {/* Sat next to the slider it demonstrates rather than under the sample, because it is the
              slider that needs explaining and the button is the explanation. */}
          <button
            onClick={() => setPlaying(playing ? null : "whale")}
            style={{ fontSize: "0.74rem", alignSelf: "flex-start" }}
            title={t("Show a sample find over the preview above", "Afficher une découverte d'exemple sur l'aperçu ci-dessus")}
          >
            {playing ? t("Stop", "Arrêter") : t("Play a sample find", "Jouer une découverte d'exemple")}
          </button>

          {/* The Board is the exception to all of the above, and only for a caster: it takes these
              live off the control page, and writing them into its URL would PIN it and disconnect
              the very desk the caster is about to drive it from. See the casterBoardUrl note. */}
          {isCaster && (
            <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
              {t(
                "These apply to the clock, the key and the alert. The Board takes its transparency, text size, zoom and framing from the control page instead - set them there, mid-match, with the board in front of you.",
                "Ceci s'applique à l'horloge, à la légende et à l'alerte. Le plateau prend sa transparence, sa taille de texte, son zoom et son cadrage depuis la page de contrôle - réglez-les là-bas, en plein match, plateau sous les yeux."
              )}
            </span>
          )}

          {isCaster ? (
            <>
              <SourceRow
                label={t("Board", "Plateau")}
                url={casterBoardUrl}
                size="1000 x 1000"
                note={t(
                  "the board you aim from the control page - zoom, pan and spotlight",
                  "le plateau que vous visez depuis la page de contrôle - zoom, panoramique et projecteur"
                )}
              />
              {/* Second, and deliberately after the one this page drives: a desk that wants a board
                  wants the controllable one, and this is for the scene that has no desk. */}
              <SourceRow
                label={t("All fleets", "Toutes les flottes")}
                url={allFleetsUrl}
                size="1000 x 1000"
                note={t(
                  "every fleet's shots on one board, with nobody driving it - no control page needed",
                  "les tirs de toutes les flottes sur un plateau, sans personne aux commandes - aucune page de contrôle requise"
                )}
              />
              <SourceRow
                label={t("Caster clock", "Horloge du commentateur")}
                url={clockUrl}
                size="1200 x 300"
                note={t(
                  "the match clock, every fleet's hulls, and the odds bar under it",
                  "l'horloge de la partie, les coques de chaque flotte, et la barre de cotes en dessous"
                )}
              />
              <SourceRow
                label={t("Key", "Légende")}
                url={keyUrl}
                size="1920 x 90"
                note={t(
                  "a thin strip for the bottom edge - add ?plate=0 for no backing",
                  "une fine bande pour le bas de l'écran - ajoutez ?plate=0 pour ne pas avoir de fond"
                )}
              />
              <SourceRow
                label={t("Audio", "Audio")}
                url={audioUrl}
                size="100 x 100"
                note={t(
                  "the board's sound - no picture. Tick 'Control audio via OBS' for its own fader",
                  "le son du plateau - pas d'image. Cochez « Contrôler l'audio via OBS » pour son propre fader"
                )}
              />

              <SourceRow
                label={t("Finds", "Découvertes")}
                url={eggUrl}
                size="600 x 600"
                note={t(
                  "empty until the water gives something up, then the find for a few seconds - add ?secs=8 to hold it longer",
                  "vide jusqu'à ce que l'eau révèle quelque chose, puis la découverte pendant quelques secondes - ajoutez ?secs=8 pour la garder plus longtemps"
                )}
              />

              {/* Not a browser source, and listed apart so nobody pastes it into OBS. */}
              <div className="stack" style={{ gap: "0.15rem" }}>
                <span style={{ fontSize: "0.78rem" }}>{t("Control page", "Page de contrôle")}</span>
                <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
                  {t("Open", "Ouvrez")} <a href={castUrl}>{castUrl}</a>{" "}
                  {t(
                    "in a normal browser window - not in OBS. It drives the Board source above: zoom, pan, spotlight, which fleets' markers show, and the transparency and text size for the scene.",
                    "dans une fenêtre de navigateur normale - pas dans OBS. Elle pilote la source Board ci-dessus : zoom, panoramique, projecteur, quelles flottes affichent leurs marqueurs, et la transparence et la taille du texte de la scène."
                  )}
                </span>
              </div>

              <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
                {t(
                  "The odds bar is a caster's instrument, so it's on this clock and not on a crew's. It runs on the public shot log in the browser, so it isn't locked to this page - it's simply not something to put in front of somebody who's still playing.",
                  "La barre de cotes est un instrument de commentateur, donc elle est sur cette horloge et pas sur celle d'une équipe. Elle tourne sur le journal public des tirs dans le navigateur, donc elle n'est pas verrouillée à cette page - ce n'est simplement pas quelque chose à mettre sous les yeux de quelqu'un qui joue encore."
                )}
              </span>
            </>
          ) : (
            <>
              {/* First, because it is the board the player is actually looking at. */}
              <SourceRow
                label={t("Fire board", "Plateau de tir")}
                url={fireUrl}
                size="1000 x 1000"
                note={t(
                  `${teamName(crew!)}'s own shots - the board they're playing off`,
                  `Les tirs de ${teamName(crew!)} - le plateau sur lequel iels jouent`
                )}
              />

              {/* Directly under the board it replaces, because that is the choice being made: one
                  of these two, not both. A scene with the pair in it is the same board twice. */}
              <SourceRow
                label={t("Fire board (small)", "Plateau de tir (petit)")}
                url={fireMiniUrl}
                size="400 x 400"
                note={t(
                  "the same board for a corner - square colours instead of names, and no text at all. Add ?coords=1 for the A-J and 1-10 labels",
                  "le même plateau pour un coin de l'écran - des couleurs de case au lieu de noms, et aucun texte du tout. Ajoutez ?coords=1 pour les repères A-J et 1-10"
                )}
              />

              {canDrawFleet ? (
                <SourceRow
                  label={t("Your fleet", "Votre flotte")}
                  url={fleetUrl}
                  size="400 x 400"
                  note={t(
                    "your ships and the damage they've taken - the small board from your screen",
                    "vos navires et les dégâts qu'ils ont subis - le petit plateau de votre écran"
                  )}
                />
              ) : (
                <div className="stack" style={{ gap: "0.15rem" }}>
                  <span style={{ fontSize: "0.78rem" }}>{t("Your fleet", "Votre flotte")}</span>
                  <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
                    {myTeam === null
                      ? t(
                          "Only the crew themselves can put this on stream - it's drawn with their rejoin code, from this page, while they're on the fleet.",
                          "Seule l'équipe elle-même peut mettre ceci en stream - c'est dessiné avec son code de reconnexion, depuis cette page, tant qu'elle est sur la flotte."
                        )
                      : t(
                          `You're on ${teamName(myTeam)}, so this is the one source you can't build for ${teamName(crew!)}. Pick your own fleet above to get it.`,
                          `Vous êtes dans ${teamName(myTeam)}, donc c'est la seule source que vous ne pouvez pas construire pour ${teamName(crew!)}. Choisissez votre propre flotte ci-dessus pour l'obtenir.`
                        )}
                  </span>
                </div>
              )}

              {/* The warning belongs on the row, not on a toggle three rows up: the decision is made
                  at the moment the URL is copied, and that is the moment it has to be readable. */}
              {canDrawFleet && (
                <span style={{ fontSize: "0.68rem", lineHeight: 1.35, color: "var(--hit)" }}>
                  <strong>
                    {t(
                      "The Fleet URL draws your ships and carries your rejoin code. Put it on stream only if you want viewers to see where your hulls are, and share it with nobody.",
                      "L'URL de la flotte dessine vos navires et porte votre code de reconnexion. Ne la mettez en stream que si vous voulez que les spectateurs voient où sont vos coques, et ne la partagez avec personne."
                    )}
                  </strong>
                </span>
              )}

              <SourceRow
                label={t("Clock", "Horloge")}
                url={clockUrl}
                size="1200 x 200"
                note={t(
                  "the match clock and every fleet's hulls, with yours marked",
                  "l'horloge de la partie et les coques de chaque flotte, avec les vôtres repérées"
                )}
              />
              <SourceRow
                label={t("Key", "Légende")}
                url={keyUrl}
                size="1920 x 90"
                note={t(
                  "a thin strip for the bottom edge - add ?plate=0 for no backing",
                  "une fine bande pour le bas de l'écran - ajoutez ?plate=0 pour ne pas avoir de fond"
                )}
              />

              <SourceRow
                label={t("Finds", "Découvertes")}
                url={eggUrl}
                size="600 x 600"
                note={t(
                  "empty until the water gives something up, then the find for a few seconds - add ?secs=8 to hold it longer",
                  "vide jusqu'à ce que l'eau révèle quelque chose, puis la découverte pendant quelques secondes - ajoutez ?secs=8 pour la garder plus longtemps"
                )}
              />

              {/* The one source with nothing to look at, so the size is a formality and the note has
                  to do the whole job of saying what it is. Listed last for the same reason: it is
                  the only one whose placement in the scene doesn't matter. */}
              <SourceRow
                label={t("Audio", "Audio")}
                url={audioUrl}
                size="100 x 100"
                note={t(
                  "the board's sound - no picture. Tick 'Control audio via OBS' for its own fader",
                  "le son du plateau - pas d'image. Cochez « Contrôler l'audio via OBS » pour son propre fader"
                )}
              />
            </>
          )}

          {/* Said here because the alternative is a streamer discovering it live and assuming their
              source is broken. See lib/overlayReveal.ts. */}
          <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
            {t(
              "Square names, square colours and the colour key stay blank until the match starts, so nobody can read the board during placement. That includes you.",
              "Les noms de case, les couleurs de case et la légende des couleurs restent vides jusqu'au début de la partie, pour que personne ne puisse lire le plateau pendant le placement. Vous y compris."
            )}
          </span>
        </>
      )}
    </div>
  );
}
