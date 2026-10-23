import { useEffect, useMemo } from "react";
import { useOverlaySource, type OverlaySourceProps } from "../hooks/useOverlaySource";
import { useRoom } from "../hooks/useRoom";
import { useCastScreens } from "../hooks/useCastScreens";
import { BOARD_SLOT, useFrameCards, type StatCard } from "../lib/castAux";
import {
  boardRect,
  CAST_ART,
  CAST_CANVAS,
  CAST_SEATS,
  PLAYER_ART,
  bannerSliceStyle,
  casterPlateRects,
  fleetStripRects,
  frac,
  screenRects,
  type Rect,
} from "../lib/castSceneLayout";
import { useCastReceiver } from "../lib/overlayCast";
import { screensFromRoster } from "../lib/castScreens";
import { groupIntoShots } from "../lib/attackFeed";
import { buildPlayerStats } from "../lib/matchReport";
import { teamHex, teamName } from "../lib/teamColors";
import { useFrameBeacon } from "../lib/frameBeacon";
import "./OverlayFrame.css";

/**
 * The frame art for a casting scene, as a full-canvas source.
 *
 * -- Two layouts ----------------------------------------------------------------------------------
 *
 * `?layout=cast`    the match frame (battleship-overlays.png): holes for the six player streams, the
 *                   board and the two caster cams, and the water banner the clock sits on.
 *
 * `?layout=casters` the break frame (battleship-casters.png): two big camera holes over the sea, with
 *                   the wordmark, for the parts of a broadcast that are not a match.
 *
 * `?layout=player`  a crew member's own frame (player-overlay.png): holes for their fire board,
 *                   gameplay, fleet and webcam. See playerSceneParts in lib/obsScene.
 *
 * -- The holes ------------------------------------------------------------------------------------
 *
 * The art's holes are transparent. The streams, the board and the webcams go BEHIND this in the scene
 * and show through; lib/castSceneLayout holds the same holes as rects, so the scene puts each source
 * exactly under its hole. Nothing here captures or composites video. It carries no live data and
 * needs no room - a caster shows the break scene precisely when there is no match.
 *
 * -- The player frame says it is showing --------------------------------------------------------
 *
 * With `?layout=player` and an owner (the account the token resolved to), the page announces that
 * owner's frame is up for as long as it runs - see lib/frameBeacon. That is how a caster's box knows
 * to crop that player's Twitch feed to the gameplay hole, with nothing for anyone to tick.
 *
 * -- The match frame wears the fleets' colours ----------------------------------------------------
 *
 * With `?layout=cast` and a room, the white strips against each side's column are painted in the
 * colour of the fleet in those boxes (fleetStripRects). The sides come from the same slot order the
 * screen sources use (lib/castScreens): slots 0-2 down the left, 3-5 down the right. No room - the
 * caster between matches - and the strips stay the art's white.
 *
 * -- And the players' names -------------------------------------------------------------------------
 *
 * In the top-right of each player hole: the player's name in their fleet's colour over a live
 * hit / miss / accuracy line. Drawn HERE, once, rather than by each screen source, so all six are the
 * same size whatever size a caster gave each Browser Source, and they sit on the top layer with the
 * art. The numbers are buildPlayerStats over the room's public attack log - the same function the
 * recap uses, so the tag and the recap can never disagree.
 *
 * -- And the talking points ------------------------------------------------------------------------
 *
 * A caster's talking point sent to one player's box (lib/castAux's CARD) is drawn over that box's
 * hole here, not by the box: anything in the box's own page over the Twitch player makes Twitch pause
 * the stream. See useFrameCards. A point about nobody in particular (BOARD_SLOT) goes over the board.
 *
 * -- And the casters' names -------------------------------------------------------------------------
 *
 * Under each cam hole, a plate on a slice of the art's own water banner carrying that caster's name,
 * typed on the caster desk and sent on the cast channel (CastView.casters) - so it changes live,
 * with nothing to re-import. No desk, or an empty name, and there is no plate.
 */

function place(rect: Rect) {
  const f = frac(rect);
  return { left: `${f.left * 100}%`, top: `${f.top * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%` };
}

function Strip({ rect, color }: { rect: Rect; color: string }) {
  return <div className="ovf-strip" style={{ ...place(rect), background: color }} />;
}

function PlayerTag({ rect, name, color, hits, misses, accuracy }: { rect: Rect; name: string; color: string; hits: number; misses: number; accuracy: number }) {
  return (
    <div className="ovf-seat" style={place(rect)}>
      <div className="ovf-tag" style={{ ["--ovf-accent" as string]: color }}>
        <span className="ovf-name">{name}</span>
        <span className="ovf-stats">
          <span>H- {hits}</span>
          <span>M- {misses}</span>
          <span>A- {accuracy}%</span>
        </span>
      </div>
    </div>
  );
}

/** The barnacle that says a talking point, by mood. Unknown moods (an older desk) get the smug one. */
const BARNACLE_MOODS = ["happy", "smug", "grim", "angry"] as const;
function barnacleSrc(mood: string | undefined): string {
  const known = (BARNACLE_MOODS as readonly string[]).includes(mood ?? "") ? mood : "smug";
  return `${import.meta.env.BASE_URL}media/barnacles/barnacle-${known}.png`;
}

/**
 * A caster's talking point over one player's hole: a barnacle climbs up from the bottom edge and says
 * it. Drawn here and not by the box - see useFrameCards for why. `--ovf-box` is the hole's share of the
 * canvas width, so the card is sized off the box exactly as it was when the box drew it.
 */
function SeatCard({ rect, card, width = rect.w }: { rect: Rect; card: StatCard; width?: number }) {
  return (
    <div className="ovf-seat" style={{ ...place(rect), ["--ovf-box" as string]: width / CAST_CANVAS.w }}>
      {/* Keyed on the point, so a new card replays the entrance rather than swapping words under one already up. */}
      <div
        key={card.id}
        className="ovf-card"
        style={{
          ["--ovf-card-team" as string]: card.team === null ? "#d9a441" : teamHex(card.team),
          ["--ovf-card-ms" as string]: `${card.ms}ms`,
        }}
      >
        <img className="ovf-card-barnacle" src={barnacleSrc(card.mood)} alt="" />
        <div className="ovf-card-bubble">{card.text}</div>
      </div>
    </div>
  );
}

function CasterPlate({ rect, name, art }: { rect: Rect; name: string; art: string }) {
  return (
    <div className="ovf-plate" style={{ ...place(rect), backgroundImage: `url(${art})`, ...bannerSliceStyle(rect) }}>
      <span>{name}</span>
    </div>
  );
}

export function OverlayFrame(props: OverlaySourceProps = {}) {
  const { code, params, owner } = useOverlaySource(props);
  const layout = params.get("layout") ?? "casters";
  // The token's owner only - a `?owner=` typed into a URL must not light somebody else's beacon.
  useFrameBeacon(layout === "player" ? props.owner : null);

  // Only the match frame needs the room, and only for which fleet is on which side.
  const state = useRoom(layout === "cast" ? code : undefined);
  const sides = useMemo(() => {
    const screens = screensFromRoster(state.players, new Map());
    return { left: screens[0]?.team ?? null, right: screens[CAST_SEATS / 2]?.team ?? null };
  }, [state.players]);
  const { message } = useCastReceiver(layout === "cast" ? code : undefined, owner);
  const casters = message?.view.casters ?? [];
  // The talking points the desk puts over a player's box - drawn here, over the hole, never in the box.
  const cards = useFrameCards(layout === "cast" ? code : undefined, owner);

  // The players in their boxes, with names off their profiles, and each one's running tally.
  const screens = useCastScreens(state.players);
  const stats = useMemo(
    () => buildPlayerStats(state.players, groupIntoShots(state.attacks, state.players)),
    [state.players, state.attacks]
  );
  const holes = screenRects();

  // Fetched up front, so the first card does not pop up as a speech bubble with nobody saying it.
  useEffect(() => {
    if (layout !== "cast") return;
    for (const mood of BARNACLE_MOODS) new Image().src = barnacleSrc(mood);
  }, [layout]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  const file = layout === "player" ? PLAYER_ART.frame : layout === "cast" ? CAST_ART.match : CAST_ART.break;
  const art = `${import.meta.env.BASE_URL}${file}`;

  return (
    <div className="ovf">
      <img className="ovf-art" src={art} alt="" />
      {layout === "cast" &&
        (["left", "right"] as const).map((side) =>
          sides[side] === null
            ? null
            : fleetStripRects(side).map((r, i) => <Strip key={`${side}${i}`} rect={r} color={teamHex(sides[side] as number)} />)
        )}
      {layout === "cast" &&
        screens
          .filter((s) => s.slot < holes.length)
          .map((s) => {
            const mine = stats.find((p) => p.playerId === s.playerId);
            return (
              <PlayerTag
                key={s.slot}
                rect={holes[s.slot]}
                name={s.name ?? teamName(s.team)}
                color={teamHex(s.team)}
                hits={mine?.hits ?? 0}
                misses={mine?.misses ?? 0}
                accuracy={mine ? Math.round(mine.accuracy * 100) : 0}
              />
            );
          })}
      {layout === "cast" &&
        [...cards].map(([slot, card]) =>
          slot === BOARD_SLOT ? (
            // About nobody in particular: over the board, sized as a player box's card so every card on
            // stream reads the same.
            <SeatCard key={slot} rect={boardRect()} card={card} width={holes[0]?.w ?? boardRect().w} />
          ) : slot >= 0 && slot < holes.length ? (
            <SeatCard key={slot} rect={holes[slot]} card={card} />
          ) : null
        )}
      {layout === "cast" &&
        casterPlateRects().map((r, i) => {
          const name = (casters[i] ?? "").trim();
          return name ? <CasterPlate key={i} rect={r} name={name} art={art} /> : null;
        })}
    </div>
  );
}
