import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useWatchSession } from "../hooks/useWatchSession";
import { useRoom } from "../hooks/useRoom";
import { useBoxSize } from "../hooks/useBoxSize";
import { fetchWatchFleet, type WatchFleet } from "../lib/watchStream";
import { activeTeams } from "../lib/battleshipLogic";
import { deepWater } from "../lib/deepWater";
import { groupIntoShots } from "../lib/attackFeed";
import { igonAnchor } from "../lib/challenges";
import { setEgressRole, setEgressRoom } from "../lib/egressMeter";
import { teamName, teamHex } from "../lib/teamColors";
import { formatRoomCode } from "../lib/roomCode";
import { MatchClock } from "../components/MatchClock";
import { SpectateWithCrew } from "../components/SpectateWithCrew";
import { LoadingScreen } from "../components/BrandMark";
import "./Spectator.css";

/**
 * A streamer's audience, watching over their shoulder.
 *
 * -- What this page is ---------------------------------------------------------------------------
 *
 * One public URL per streamer - /watch/theirtwitchname - that always shows the match they are in
 * right now, from their seat and from no other. It is what a streamer puts in a Twitch panel or
 * behind a !watch command, once, for a season.
 *
 * -- Why it is not the spectator page with a couple of buttons hidden ----------------------------
 *
 * The room's own spectator view can already do everything here, and two of the things it can do are
 * the reasons this exists instead.
 *
 * It names a room, so the link is stale by the next match - which rules out every place an audience
 * actually looks for one. That half is the same problem the overlay tokens solved, and it is solved
 * the same way: the URL names the PERSON and the room is resolved at read time.
 *
 * And getting there means JOINING - a `players` row with team null - which is the key to "fleets
 * select by spectator" and "square_counts select by spectator". Handing that to an audience of
 * strangers hands every one of them the other crew's ship positions, the streamer's opponent
 * included. So nobody joins here. This page writes nothing and reads only tables that are already
 * world-readable, which means the promise it makes - you cannot see both sides - is a property of
 * the schema rather than a rule in this file. There is no switch here to find, because there is
 * nothing to switch: the rows are not reachable from a seat that does not exist.
 *
 * The visible consequence is the second board. A viewer sees every hit, miss and sinking that has
 * landed on the streamer's fleet, and sees their hulls only if the streamer has opted in - see
 * fetchWatchFleet, where the consent is enforced in the database rather than here.
 *
 * -- What it deliberately does NOT have ----------------------------------------------------------
 *
 * No view switcher. The spectator page has one, and every position on it except this one is either
 * the other crew's board or a view of the whole room - which is the thing being withheld. A control
 * that only ever had one legal setting is not a control.
 *
 * No sound. An audience member is already listening to the stream, and a second copy of every shot
 * playing a few hundred milliseconds out from the one they can hear is worse than silence. The
 * streamer has the audio source for their own broadcast.
 *
 * No odds. Same rule the overlays keep: the evaluation bar is a caster's instrument, and this page
 * is pointed at the people in a streamer's chat - who are talking TO them.
 */
export function Watch() {
  const { handle } = useParams<{ handle: string }>();
  const { loading, session } = useWatchSession(handle);

  const code = session?.roomCode ?? undefined;
  const state = useRoom(code);

  /**
   * Tell the byte meter what this tab is.
   *
   * An audience is where a popular match's realtime cost actually comes from - one streamer with
   * four hundred viewers is four hundred subscribers on one room - so filing them under the route's
   * guess would hide the single biggest line in the bill. They are counted as spectators because
   * that is what they are, seat or no seat.
   */
  useEffect(() => setEgressRole("spectator"), []);
  useEffect(() => {
    if (code) setEgressRoom(code, "spectator");
  }, [code]);

  /**
   * The streamer's own hulls, but only if they have said yes.
   *
   * Tri-state is not needed here the way it is on the overlay sources: there is no fault to report,
   * because "no ships" is a legitimate and common answer rather than a broken URL. Null simply means
   * the second board draws damage without hulls, which is what the switch being off looks like.
   *
   * Re-fetched when the room's status changes, because placements are replaced wholesale on a
   * rematch - a tab left open overnight would otherwise still be drawing last night's fleet - and
   * when the consent changes, so a streamer turning the switch off mid-match takes the hulls off
   * every viewer's screen rather than only off the screens of people who arrive later.
   */
  const [fleet, setFleet] = useState<WatchFleet | null>(null);
  const roomStatus = state.room?.status;
  const showFleet = session?.showFleet ?? false;
  useEffect(() => {
    if (!handle || !showFleet) {
      setFleet(null);
      return;
    }
    let cancelled = false;
    void fetchWatchFleet(handle).then((f) => {
      if (!cancelled) setFleet(f);
    });
    return () => {
      cancelled = true;
    };
    // `roomStatus` is not read in here and is not meant to be: it is in the list purely as the
    // signal to re-fetch. Same arrangement as the fleet overlay source.
  }, [handle, showFleet, roomStatus]);

  // The stage the two boards are measured into. See Spectator.css for why this page measures rather
  // than capping boards in vh.
  const [stageRef, stage] = useBoxSize<HTMLDivElement>();

  const room = state.room;
  const { attacks, players, deepHides } = state;

  /**
   * What this crew has found in the water - narrowed to their finds inside SpectateWithCrew.
   *
   * Built here because it needs the room's roster, which that component has never taken. Handed over
   * whole; the narrowing to one crew's view is its job and it is the same call the players' own
   * board makes.
   */
  const deep = useMemo(
    () => (room ? deepWater(room, groupIntoShots(attacks, players), deepHides, igonAnchor(room)) : undefined),
    [room, attacks, players, deepHides]
  );
  const activeTeamsList = useMemo(() => activeTeams(players), [players]);

  const name = session?.streamerName ?? handle ?? "This streamer";

  // One round trip, and nothing on screen until it lands. A page that flashed "no such streamer"
  // on the way to drawing a match would do it on every single open.
  if (loading) return <LoadingScreen>Finding the match...</LoadingScreen>;

  /**
   * Three empty states, and they are three different sentences on purpose.
   *
   * A viewer who has followed a link out of a stream cannot tell a typo from a streamer between
   * matches, and "nothing here" would leave them refreshing at the wrong one. The first is a dead
   * end; the other two fix themselves, and say so, because this page picks the match up on its own
   * the moment one starts - see useFollowedSeat.
   */
  if (!session) {
    return (
      <div className="stack" style={{ width: "min(720px, 100%)", gap: "0.5rem" }}>
        <h2>No streamer here</h2>
        <p className="muted">
          Nobody plays under the name <strong>{handle}</strong>. Watch links use the streamer's
          Twitch name, so check the spelling - or ask them for their link again.
        </p>
      </div>
    );
  }

  if (!code || !room) {
    return (
      <div className="stack" style={{ width: "min(720px, 100%)", gap: "0.5rem" }}>
        <h2>{name} isn't in a match</h2>
        <p className="muted">
          Leave this page open - it'll pick up their next match on its own, with no reload. Nothing
          to refresh and nothing to click.
        </p>
      </div>
    );
  }

  if (session.team === null) {
    return (
      <div className="stack" style={{ width: "min(720px, 100%)", gap: "0.5rem" }}>
        <h2>{name} is watching this one</h2>
        <p className="muted">
          They're in {formatRoomCode(code)} as a spectator rather than on a fleet, so there's no crew
          to ride with. This page will follow them into their next match.
        </p>
      </div>
    );
  }

  const team = session.team;

  return (
    <div className="spectate">
      {/*
        One bar, and far less in it than the spectator page's.

        The clock leads it for the same reason it leads that one - it is the thing most worth reading
        and the thing that used to scroll away. What is missing is the view switcher, and its absence
        is the feature: see the note at the top.
      */}
      <div className="spectate-bar">
        <MatchClock attacks={attacks} room={room} compact />

        {room.status === "finished" && room.winner_team !== null && (
          <strong style={{ color: teamHex(room.winner_team), fontSize: "0.85rem" }}>
            {teamName(room.winner_team)} wins
          </strong>
        )}

        <span className="spectate-divider" />
        <span className="spectate-label">Watching with</span>
        <strong style={{ color: teamHex(team), fontSize: "0.85rem" }}>{name}</strong>
        <span className="muted" style={{ fontSize: "0.75rem" }}>
          on {teamName(team)} · {formatRoomCode(code)}
        </span>

        <span className="spectate-bar-spacer" />
      </div>

      <div className="spectate-stage" ref={stageRef}>
        <SpectateWithCrew
          room={room}
          team={team}
          attacks={attacks}
          // The one fleet an RPC was willing to hand over, or none. Never `state.revealedFleets`,
          // which for a viewer with no seat is empty anyway - naming it here would suggest this page
          // would happily draw every crew's ships if only RLS let it, and it would not.
          fleets={fleet ? [{ team: fleet.team, placements: fleet.placements }] : []}
          activeTeamsList={activeTeamsList}
          // No counts. Square tallies live behind the same spectator-seat gate the fleets do, so
          // there is nothing to pass - and a viewer reading a crew's working-out is a step closer to
          // the backseating this page exists to make impossible.
          deep={deep}
          stage={stage}
          noFleetNote={
            <>
              {name} hasn't turned on showing their own ships, so their hulls aren't drawn. Every
              hit, miss and sinking on their fleet is here either way.
            </>
          }
        />
      </div>
    </div>
  );
}
