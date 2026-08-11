import { useState } from "react";
import { teamName, teamHex } from "../lib/teamColors";
import { MIN_OPACITY } from "../lib/overlayCast";
import { TEXT_SIZE_OPTIONS } from "../lib/overlayText";
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
  /** Every fleet in the room, so the board source can be pointed at one of them. */
  teams?: number[];
}

/**
 * The player's OBS sources: the same three the caster gets, plus a few decisions of their own.
 *
 * -- Why this used to be a form and isn't any more --
 *
 * It built one all-in-one HUD column and offered seven controls to shape it: which edge to hug,
 * whether to draw boards, one board or two, three cell sizes, boss names on or off, ships on or
 * off. Every one of those existed to make a 200px-wide strip carry a whole match, and most of them
 * were really the same question asked sideways - "is this readable?" - which the strip could only
 * ever answer no to.
 *
 * The three separate sources answer it properly: a full-size board that can be zoomed, a clock, and
 * a colour key, each placed where the streamer wants it. What survives of that form is only what a
 * streamer cannot settle by dragging a source around in OBS: whether their own ships go on stream,
 * and the two scene-wide settings below - how solid it all is, and how large the text is. The rest
 * of those seven controls were layout, and layout belongs in OBS.
 *
 * (The old column still exists at /overlay/:code with all its query parameters, for anyone running
 * one. It just isn't something anyone has to configure here to get started.)
 *
 * -- Why this is worth opening in the LOBBY ---------------------------------------------------
 *
 * A stream scene gets built before the match, not during it, so the fleet chooser has to work in a
 * lobby: one fleet in the room, or none picked yet, and it still has to let you say which board is
 * yours. It used to hide itself until two fleets had players, which meant the first person into the
 * room - usually the one streaming, who arrived early precisely to set up - was the one person who
 * couldn't. What they got instead was the all-fleets fallback, pointed at nobody in particular.
 *
 * And because the box is opened before you join a fleet as often as after, the board follows your
 * fleet until you overrule it. Opening this, then picking Blue, then finding your source still
 * aimed at "all" is a trap that only springs on stream.
 *
 * Built from window.location so the URLs stay correct on localhost, on GitHub Pages under its
 * /Elden-Battleship/ base, and anywhere else it gets hosted - hardcoding the deployed origin would
 * hand every local tester a link pointing at production.
 */
export function OverlayLinkBox({ roomCode, team, rejoinCode, teams }: Props) {
  const [open, setOpen] = useState(false);
  const [showShips, setShowShips] = useState(false);
  /**
   * Which fleet's board goes on stream, once the player has said.
   *
   * `undefined` means they haven't - which is not the same as `null` ("all fleets, deliberately").
   * Until they do, the board follows whichever fleet they join, so the lobby order that everyone
   * actually uses - open this, then pick a colour - ends up with a source aimed at themselves.
   */
  const [pickedTeam, setPickedTeam] = useState<number | null | undefined>(undefined);
  /** How solid the whole scene is on stream. One setting, written into all three sources. */
  const [opacity, setOpacity] = useState(1);
  /**
   * How large the text is on stream. One setting, written into all three sources - same reasoning as
   * the transparency slider below it, spelled out in lib/overlayText.
   */
  const [textSize, setTextSize] = useState(1);

  const myTeam = team !== null && team !== undefined ? team : null;
  const boardTeam = pickedTeam !== undefined ? pickedTeam : myTeam;
  const canShowShips = Boolean(rejoinCode) && myTeam !== null;

  /**
   * The fleets this board can be pointed at: everyone in the room, plus your own.
   *
   * Your own is unioned in rather than assumed present because `teams` is the fleets that have
   * players, and in a lobby you may be the only one in it - the list would otherwise be missing the
   * one entry that matters to the person reading it.
   */
  const boardOptions = Array.from(new Set([...(teams ?? []), ...(myTeam !== null ? [myTeam] : [])])).sort(
    (a, b) => a - b
  );
  // Ships come from the fleet the rejoin code unlocks, so they can only ever appear on that fleet's
  // own board. Asking for them while watching an opponent's board would be a promise we can't keep.
  const shipsApply = showShips && canShowShips && boardTeam === myTeam;

  const base = `${window.location.origin}${window.location.pathname}`;

  /**
   * The two settings every source shares, appended last.
   *
   * Only written when they are actually doing something - a URL full of defaults is harder to read,
   * and harder to hand-edit afterwards, which is the escape hatch for anyone who wants one source to
   * differ from the other two.
   */
  const withScene = (q: URLSearchParams) => {
    if (opacity < 1) q.set("opacity", opacity.toFixed(2));
    if (textSize !== 1) q.set("text", String(textSize));
    return q.toString();
  };

  const boardQuery = new URLSearchParams();
  // `pin=1` rather than an empty query when every fleet is wanted: a board source with no
  // parameters at all is the CASTER's, waiting to be aimed from a control page. See pinnedView.
  if (boardTeam !== null) boardQuery.set("team", String(boardTeam));
  else boardQuery.set("pin", "1");
  // The credential is attached only when it is actually going to be used - no reason to leave a
  // bearer token sitting in an OBS config that isn't drawing ships.
  if (shipsApply) boardQuery.set("key", rejoinCode!);

  const clockQuery = new URLSearchParams();
  if (myTeam !== null) clockQuery.set("team", String(myTeam));

  const boardUrl = `${base}#/overlay-board/${roomCode}?${withScene(boardQuery)}`;
  const clockQs = withScene(clockQuery);
  const clockUrl = `${base}#/overlay-timer/${roomCode}${clockQs ? `?${clockQs}` : ""}`;
  const keyQs = withScene(new URLSearchParams());
  const keyUrl = `${base}#/overlay-key/${roomCode}${keyQs ? `?${keyQs}` : ""}`;

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
        Which fleet is yours - the first thing to settle, and the one that has to work in a lobby.
        Shown whatever the room looks like, including a room containing only you: see the note on
        boardOptions and the lobby paragraph above.
      */}
      <div className="stack" style={{ gap: "0.25rem" }}>
        <span style={{ fontSize: "0.78rem" }}>Which fleet's board goes on stream?</span>
        {myTeam === null ? (
          <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
            You're not on a fleet yet. Pick one in the lobby and the board follows it - or leave
            this on <em>All fleets</em> to show every fleet's shots on one board.
          </span>
        ) : (
          <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
            Your fleet's board shows what's been done <em>to</em> you; an opponent's shows your own
            shots landing.
          </span>
        )}
        <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
          {boardOptions.map((t) => (
            <button
              key={t}
              onClick={() => setPickedTeam(t)}
              style={{
                fontSize: "0.74rem",
                color: teamHex(t),
                borderColor: boardTeam === t ? "var(--accent)" : undefined,
              }}
            >
              {t === myTeam ? `${teamName(t)} (you)` : teamName(t)}
            </button>
          ))}
          <button
            onClick={() => setPickedTeam(null)}
            style={{ fontSize: "0.74rem", borderColor: boardTeam === null ? "var(--accent)" : undefined }}
          >
            All fleets
          </button>
        </div>
      </div>

      {/* Everything else about these sources is either fixed or a matter of where you drag them
          in OBS. */}
      <div className="stack" style={{ gap: "0.25rem" }}>
        <span style={{ fontSize: "0.78rem" }}>Show my ships on stream?</span>
        <div className="row" style={{ gap: "0.3rem" }}>
          <button
            onClick={() => setShowShips(false)}
            style={{ flex: 1, fontSize: "0.74rem", borderColor: showShips ? undefined : "var(--accent)" }}
          >
            No - snipe-safe
          </button>
          <button
            onClick={() => setShowShips(true)}
            disabled={!canShowShips}
            title={canShowShips ? undefined : "Needs a fleet and a rejoin code"}
            style={{
              flex: 1,
              fontSize: "0.74rem",
              opacity: canShowShips ? 1 : 0.5,
              borderColor: showShips && canShowShips ? "var(--hit)" : undefined,
            }}
          >
            Yes - show them
          </button>
        </div>
        {shipsApply && (
          <span style={{ fontSize: "0.68rem", lineHeight: 1.35, color: "var(--hit)" }}>
            <strong>
              The board URL now shows your ship positions and contains your rejoin code. Put it on
              stream only if you're happy for viewers to see your fleet, and don't share the URL.
            </strong>
          </span>
        )}
        {showShips && canShowShips && boardTeam !== myTeam && (
          <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
            Showing {teamName(boardTeam!)}'s board, so no ships are drawn - only your own fleet can
            ever be revealed. Switch the board to {teamName(myTeam!)} to see yours.
          </span>
        )}
      </div>

      {/*
        Text size, offered as named steps rather than a slider.

        A slider is right for transparency, where every value in the range is as good as its
        neighbour and what you want is the one that looks right over YOUR footage. Legibility isn't
        like that: the question behind it is "who is watching, and on what", and the answers are a
        handful of distinct situations rather than a continuum. Named steps say what each one is for
        - which is the part a streamer setting up a scene at 3am actually needs - and land on round
        numbers that stay round in the URL.

        Deliberately in the box rather than only in the URL: this is the setting most likely to be
        wrong on the first try and most likely to need changing between one stream and the next.
      */}
      <div className="stack" style={{ gap: "0.25rem" }}>
        <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
          <span style={{ fontSize: "0.78rem" }}>Text size</span>
          <span className="muted" style={{ fontSize: "0.72rem" }}>
            {TEXT_SIZE_OPTIONS.find((o) => o.value === textSize)?.note ?? `${textSize}x`}
          </span>
        </div>
        <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
          {TEXT_SIZE_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => setTextSize(o.value)}
              title={o.note}
              aria-pressed={textSize === o.value}
              style={{
                fontSize: "0.74rem",
                borderColor: textSize === o.value ? "var(--accent)" : undefined,
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
          Square names, coordinates, the clock and the key, all together. Nothing here can overflow a
          square or push the key off the edge - a size a source has no room for simply draws as large
          as it fits, so the clock and key need a taller browser source before the biggest steps show.
        </span>
      </div>

      {/*
        One slider for the whole scene rather than one per source.
        These three are dropped into a single layer over the same gameplay, and a board at half
        strength under a solid scorebug looks like a mistake rather than a choice. Anyone who really
        does want them to differ can still edit ?opacity= on the one URL afterwards - the sources
        read the parameter, they just aren't asked about it separately here.
      */}
      <div className="stack" style={{ gap: "0.25rem" }}>
        <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
          <span style={{ fontSize: "0.78rem" }}>Overlay transparency</span>
          <span className="muted" style={{ fontSize: "0.72rem" }}>
            {opacity >= 1 ? "solid" : `${Math.round(opacity * 100)}%`}
          </span>
        </div>
        <input
          type="range"
          min={MIN_OPACITY}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          aria-label="Overlay transparency"
          style={{ width: "100%" }}
        />
        <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
          Fades all three sources so your gameplay reads through them. {Math.round(MIN_OPACITY * 100)}% is the
          floor - below that "hidden" is the honest word, and OBS can already do that.
        </span>
      </div>

      <SourceRow
        label="Board"
        url={boardUrl}
        size="1000 x 1000"
        note={boardTeam !== null ? `${teamName(boardTeam)}'s board` : "every fleet's shots on one board"}
      />

      <SourceRow label="Clock" url={clockUrl} size="1200 x 200" note="the match clock and every fleet's hulls" />

      <SourceRow
        label="Key"
        url={keyUrl}
        size="1920 x 90"
        note="a thin strip for the bottom edge - add ?plate=0 for no backing"
      />

      {/* Said here because the alternative is a streamer discovering it live and assuming their
          source is broken. See lib/overlayReveal.ts. */}
      <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
        Square names and the colour key stay blank until the match starts, so nobody - including you
        - can read the board while fleets are still being placed.
      </span>
    </div>
  );
}
