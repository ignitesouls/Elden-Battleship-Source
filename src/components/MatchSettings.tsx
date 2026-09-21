import { useState } from "react";
import { useT } from "../lib/language";
import { updateRoomSettings } from "../lib/rooms";
import { formatDuration } from "../lib/matchTime";
import { SQUARE_SET_LIST, squareSet, displaySquareSet, squareSetVariants, DEFAULT_SQUARE_SET } from "../lib/challenges";
import { squarePool, maxBoardSize, clampBoardSize } from "../lib/challenges";
import { strictFill } from "../lib/squareSetFormat";
import { BOARD_SIZES, FLEET_PRESETS, DEFAULT_FLEET_PRESET, fleetFor, presetNameOf } from "../types/battleship";
import type { Room } from "../types/battleship";

/**
 * Preparation lengths the host can pick, every minute from none up to ten.
 *
 * A dropdown rather than the four buttons this used to be: the buttons offered 0, 1, 4 and 10 and
 * nothing between, so a room that wanted three minutes had to take four. Eleven buttons would be a
 * second wrapping row in a panel that already has ten board sizes in one.
 */
const PREP_MAX_MINUTES = 10;
const PREP_CHOICES = Array.from({ length: PREP_MAX_MINUTES + 1 }, (_, m) => m * 60);

/**
 * A prep length as it reads in the dropdown: a bare minute count, the unit living in the field
 * label. Clock faces down a list of whole minutes are all zeroes after the colon and harder to
 * scan than "0 1 2 3". A length that isn't a whole minute can only be one set by hand, so it
 * keeps the clock rather than being rounded into a lie.
 */
function prepLabel(seconds: number): string {
  return seconds % 60 === 0 ? String(seconds / 60) : formatDuration(seconds);
}

interface Props {
  room: Room;
  isHost: boolean;
  onError: (message: string | null) => void;
}

/**
 * The match settings, live in the lobby.
 *
 * They used to be set once on the front page, before the room existed - which meant nobody but the
 * creator ever saw them, and a wrong board size could only be fixed by abandoning the room and
 * re-inviting everyone. Here they are visible to the whole lobby and changeable until the match
 * starts, which is also the last moment changing them is safe: after placement begins, the board
 * size is baked into fleets that players have already laid out.
 */
export function MatchSettings({ room, isHost, onError }: Props) {
  const [working, setBusy] = useState(false);
  // An official match takes the tournament's settings and keeps them (the database refuses any change -
  // see guard_official_room), so every control here reads as busy rather than offering a change that
  // would only be refused.
  const official = !!room.tournament_match_id;
  const busy = working || official;
  const [open, setOpen] = useState(false);
  const t = useT();

  const boardSize = room.board_size;
  const cells = boardSize * boardSize;
  const shipDefs = room.ship_defs;
  const preset = presetNameOf(shipDefs, boardSize);
  const prepSeconds = room.prep_seconds ?? 240;

  // A room carrying a length this menu can't offer - set before the choices changed, or by hand -
  // keeps it as an extra entry rather than having the dropdown render blank and silently rewrite it
  // to whatever sits at the top of the list.
  const prepChoices = PREP_CHOICES.includes(prepSeconds)
    ? PREP_CHOICES
    : [...PREP_CHOICES, prepSeconds].sort((a, b) => a - b);
  // Absent reads as a real match - see Room.practice. A room from before the migration, or a
  // project that hasn't run it, is a room whose matches count, which is what they always did.
  const practice = room.practice ?? false;
  const set = squareSet(room.square_set ?? DEFAULT_SQUARE_SET);
  // What the room is told it is playing. Identical to `set` except on a variant, which describes
  // itself as its parent because that is the only set anyone here chose - see squareSets.variantOf.
  const shownSet = squareSet(displaySquareSet(set.id));

  /**
   * The cuts the chosen set comes in, parent first - two for the boss board, none for everything
   * else, which is how the row below knows whether to exist. See SquareSetDef.cutLabel.
   */
  const cuts = squareSetVariants(shownSet.id)
    .map((id) => squareSet(id))
    .filter((c) => c.cutLabel);

  const shipCells = shipDefs.reduce((n, s) => n + s.size, 0);

  // The biggest board this set can deal without repeating a square. Read off `set` and not the set
  // the room DISPLAYS, because the two differ exactly where the cap does: a 2v2 lobby shows
  // "Bosses" while sitting on the 164-square cut, whose ceiling is two sizes lower than the full
  // board's.
  const sizeCap = maxBoardSize(set);

  // How much of the board this set can cover before it has to reuse an objective family. Only
  // meaningful for the authored sets - a flat list of bosses has no such rules.
  const cleanFill = set.format === "bingo" ? strictFill(set.data, cells) : cells;
  const shortfall = Math.max(0, cells - cleanFill);

  /**
   * Puts the room on a set - or on another cut of the one it is already on, which is the same write
   * either way, since a cut is a set as far as the database is concerned.
   *
   * A set with a lower ceiling drags the board down to it in the SAME write, fleet and all. Two
   * writes would deal one board that repeats squares in between, and leaving the size alone would
   * deal that board for the whole match - which is what happened before this, invisibly, whenever a
   * host on a big board tried the smallest set.
   */
  function chooseSet(id: string) {
    const size = clampBoardSize(boardSize, id);
    void apply({
      square_set: id,
      ...(size === boardSize
        ? {}
        : { board_size: size, ship_defs: fleetFor(size, preset ?? DEFAULT_FLEET_PRESET) }),
    });
  }

  async function apply(patch: Parameters<typeof updateRoomSettings>[1]) {
    setBusy(true);
    onError(null);
    try {
      await updateRoomSettings(room.id, patch);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Practice leads rather than trailing the board size and the fleet, because it is the only one of
  // these that changes what the match IS. Somebody skim-reading a collapsed settings row is reading
  // the first thing in it, and "this one doesn't count" is the fact they most need off that glance.
  // A cut the host went out of their way to take is named here; the full board isn't, because it is
  // what "Bosses" has always meant and a suffix on the default would only ask to be read. Worth the
  // words at all because this line is what the rest of the lobby reads instead of opening the
  // panel, and "which board are we actually playing" is now a thing somebody chose.
  const cutSuffix = set.id !== shownSet.id && set.cutLabel ? ` - ${set.cutLabel.toLowerCase()}` : "";
  const summary =
    (practice ? `${t("Practice", "Entraînement")} · ` : "") +
    `${boardSize}x${boardSize} · ${preset ?? `${shipDefs.length} ${t("ships", "navires")}`} · ${shownSet.label}${cutSuffix} · ${formatDuration(
      prepSeconds
    )} ${t("prep", "prépa")}`;

  // Everyone sees the settings; only the host gets the buttons. A spectator or a player who
  // wandered in deserves to know what they're about to play without having to ask.
  if (!isHost) {
    return (
      <div className="panel row" style={{ gap: "0.5rem", alignItems: "baseline" }}>
        <span className="muted" style={{ fontSize: "0.78rem" }}>{t("Match settings", "Paramètres du match")}</span>
        <span style={{ fontSize: "0.82rem" }}>{summary}</span>
      </div>
    );
  }

  return (
    <div className="panel stack" style={{ gap: "0.55rem" }}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ fontSize: "0.82rem" }}>
        {open ? "▾" : "▸"} {t("Match settings", "Paramètres du match")}
        <span className="muted"> - {summary}</span>
      </button>

      {open && (
        <div className="stack" style={{ gap: "0.6rem", paddingLeft: "0.2rem" }}>
          {/* Resizing carries the fleet across rather than leaving a 10x10 Classic fleet on a 5x5
              board, where 17 ship squares in 25 cells cannot even be placed. */}
          <Field label={t("Board size", "Taille du plateau")}>
            {BOARD_SIZES.map((n) => (
              <Choice
                key={n}
                active={boardSize === n}
                busy={busy}
                unavailable={n > sizeCap}
                title={
                  n > sizeCap
                    ? t(
                        `${shownSet.label} has ${squarePool(set)} squares - a ${n}x${n} board would deal ${
                          n * n - squarePool(set)
                        } of them twice. Its biggest board is ${sizeCap}x${sizeCap}.`,
                        `${shownSet.label} compte ${squarePool(set)} cases - un plateau ${n}x${n} en placerait ${
                          n * n - squarePool(set)
                        } deux fois. Son plus grand plateau est ${sizeCap}x${sizeCap}.`
                      )
                    : undefined
                }
                onClick={() =>
                  void apply({ board_size: n, ship_defs: fleetFor(n, preset ?? DEFAULT_FLEET_PRESET) })
                }
              >
                {n}x{n}
              </Choice>
            ))}
          </Field>
          {/* Only worth a line when the cap actually costs the host something. On a set that reaches
              the top of the list there is nothing to explain, and on the boss board this is also
              where a 2v2 lobby finds out why the two biggest sizes went away. */}
          {sizeCap < BOARD_SIZES[BOARD_SIZES.length - 1] && (
            <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
              {t(
                `${shownSet.label} has ${squarePool(set)} squares, so it fills a ${sizeCap}x${sizeCap} board at most. A bigger board would put the same square in two places.`,
                `${shownSet.label} compte ${squarePool(set)} cases, donc il remplit au plus un plateau ${sizeCap}x${sizeCap}. Un plateau plus grand placerait la même case à deux endroits.`
              )}
            </span>
          )}

          <Field
            label={`${t("Fleet", "Flotte")} - ${shipDefs.length} ${t("ships", "navires")}, ${shipCells} ${t(
              "squares",
              "cases"
            )} (${Math.round((shipCells / cells) * 100)}% ${t("of the board", "du plateau")})`}
          >
            {Object.keys(FLEET_PRESETS).map((k) => (
              <Choice
                key={k}
                active={preset === k}
                busy={busy}
                onClick={() => void apply({ ship_defs: fleetFor(boardSize, k) })}
              >
                {k}
              </Choice>
            ))}
          </Field>
          <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
            {shipDefs.map((s) => `${s.name} (${s.size})`).join(" · ")}
          </span>

          {/* One button per set a person can choose. A set that comes in cuts is one button here
              and picks its full board; which cut is the row below, because the cuts are the same
              board and putting them in this row would mean two buttons reading "Bosses". */}
          <Field label={t("Squares", "Cases")}>
            {SQUARE_SET_LIST.map((s) => (
              <Choice
                key={s.id}
                active={displaySquareSet(set.id) === s.id}
                busy={busy}
                onClick={() => chooseSet(s.id)}
              >
                {s.label}
              </Choice>
            ))}
          </Field>

          {/* How much of that board to play, for the one set that offers a choice.

              This used to be the roster's call and not the host's: every team having one or two
              players moved a boss room onto the small-crew cut by itself, and a third player
              arriving moved it back. It got the common case right and left no way to disagree with
              it - a duo who wanted the whole map, DLC and all, could not have it, and the two board
              sizes that went away with the cut went away unexplained. So the choice is here, on
              every roster, with the full board the default it always was. A 4v4 that wants a
              shorter match can take the short board too; nothing about the cut is really about how
              many people are in the room, only about how far they can be sent.

              The caption is the ACTIVE cut's own blurb, which is why the set-level blurb this row
              replaced isn't also printed: on a set with cuts, what you are playing is the cut. */}
          {cuts.length > 1 && (
            <Field label={shownSet.cutsLabel ?? t("Squares dealt", "Cases distribuées")}>
              {cuts.map((c) => (
                <Choice key={c.id} active={set.id === c.id} busy={busy} onClick={() => chooseSet(c.id)}>
                  {c.cutLabel} - {squarePool(c)}
                </Choice>
              ))}
            </Field>
          )}
          <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
            {cuts.length > 1 ? set.blurb : shownSet.blurb}
          </span>

          <Field label={t("Preparation time before firing opens (minutes)", "Temps de préparation avant l'ouverture des tirs (minutes)")}>
            <select
              value={prepSeconds}
              disabled={busy}
              onChange={(e) => void apply({ prep_seconds: Number(e.target.value) })}
            >
              {prepChoices.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {prepLabel(seconds)}
                  {seconds === 0 ? ` - ${t("none", "aucune")}` : ""}
                </option>
              ))}
            </select>
          </Field>

          {/* The one setting here that isn't about how the match plays.

              Two buttons rather than a checkbox because everything else in this panel is a pair of
              buttons showing you which one you're on, and a lone tickbox among them is the control
              people don't see. It is also the shape that lets the OFF state say something: "Counts"
              is worth printing, because the default being a real match is exactly the thing a host
              who came here to run a test needs to have noticed.

              Lobby only, and enforced server-side (see guard_room_practice) rather than merely
              hidden here - a match that could be declared practice after the result is in would let
              the host delete any game they lost. The panel is only rendered in the lobby anyway, so
              the trigger is guarding against a stale tab, not against this code. */}
          <Field label={t("Record", "Enregistrement")}>
            <Choice active={!practice} busy={busy} onClick={() => void apply({ practice: false })}>
              {t("Counts", "Compte")}
            </Choice>
            <Choice active={practice} busy={busy} onClick={() => void apply({ practice: true })}>
              {t("Practice", "Entraînement")}
            </Choice>
          </Field>
          <span
            className="muted"
            style={{ fontSize: "0.72rem", marginTop: "-0.35rem", color: practice ? "var(--hit)" : undefined }}
          >
            {practice
              ? t(
                  "Nothing from this match reaches the leaderboard, anyone's career, the record book or the boss stats. It still gets a full recap you can open afterwards. Settled now - it can't be changed once the match starts, or undone after.",
                  "Rien de ce match n'atteint le classement, la carrière de personne, le livre des records ou les statistiques de boss. Il aura tout de même un récapitulatif complet consultable ensuite. Décidé maintenant - ça ne peut plus être changé une fois le match commencé, ni annulé après."
                )
              : t(
                  "A real match: every square, every win and every time counts. Switch to Practice for a test run or a demo, and none of it will.",
                  "Un vrai match : chaque case, chaque victoire et chaque temps compte. Passez en Entraînement pour un essai ou une démo, et rien de tout ça ne comptera."
                )}
          </span>

          {/* These sets are written for a 25-square bingo card. Dealt onto 144 cells there aren't
              enough distinct goals to keep every "only one of these" rule, so say so here rather
              than let it be discovered as two squares wanting the same boss. */}
          {shortfall > 0 && (
            <span className="muted" style={{ fontSize: "0.72rem", color: "var(--hit)" }}>
              {t(
                `${shownSet.label} covers ${cleanFill} of ${cells} squares cleanly. The last ${shortfall} will repeat goals already on the board. A smaller board fits it better.`,
                `${shownSet.label} couvre ${cleanFill} cases sur ${cells} sans répétition. Les ${shortfall} dernières répéteront des objectifs déjà sur le plateau. Un plateau plus petit lui convient mieux.`
              )}
            </span>
          )}

          {shipCells > cells * 0.35 && (
            <span className="muted" style={{ fontSize: "0.72rem", color: "var(--hit)" }}>
              {t(
                `That fleet fills a lot of a ${boardSize}x${boardSize} board, so placement may be cramped.`,
                `Cette flotte remplit une grande partie d'un plateau ${boardSize}x${boardSize}, le placement risque d'être serré.`
              )}
            </span>
          )}

          <span className="muted" style={{ fontSize: "0.72rem" }}>
            {t("Changing the board or fleet clears any ships already placed.", "Changer le plateau ou la flotte efface tous les navires déjà placés.")}
          </span>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="stack" style={{ gap: "0.25rem" }}>
      <span className="muted" style={{ fontSize: "0.78rem" }}>{label}</span>
      {/* Wraps: ten board sizes don't fit one row on a narrow window. */}
      <div className="row" style={{ gap: "0.35rem", flexWrap: "wrap" }}>{children}</div>
    </label>
  );
}

function Choice({
  active,
  busy,
  /** Out of reach on this set rather than momentarily unclickable - carries `title` and dims. */
  unavailable,
  title,
  onClick,
  children,
}: {
  active: boolean;
  busy: boolean;
  unavailable?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      disabled={busy || unavailable}
      title={title}
      onClick={onClick}
      aria-pressed={active}
      // minWidth keeps a wrapped row of board sizes from stretching three buttons across the panel
      // while five sit underneath. An unavailable size stays in the row at half opacity rather than
      // vanishing: a list that silently loses its last two entries when the roster drops to a 2v2
      // reads as a bug, where a greyed button with a reason on hover reads as the rule it is.
      style={{
        flex: "1 0 4rem",
        minWidth: "4rem",
        borderColor: active ? "var(--accent)" : undefined,
        opacity: unavailable ? 0.4 : undefined,
      }}
    >
      {children}
    </button>
  );
}
