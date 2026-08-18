import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useActiveRoom } from "../hooks/useActiveRoom";
import { formatRoomCode } from "../lib/roomCode";
import { getVolume, setVolume } from "../lib/sfx";
import { isColorblindMode, setColorblindMode } from "../lib/teamColors";
import { isTwitchLoginConfigured, signInWithTwitch, signOut } from "../lib/supabase";
import { useAuthProfile, accountName } from "../hooks/useAuthProfile";
import { useAdminStatus } from "../lib/admin";
import "./TopBar.css";

/**
 * The fixed chrome strip across the top: account, records, sound, and the colorblind palette.
 *
 * These are all app-wide preferences and identity, so they live in one place on every screen
 * rather than being duplicated into each page's layout.
 *
 * Every control is an emoji AND a word. The emoji is what survives when the window gets narrow
 * enough that TopBar.css hides the labels; the word is what stops the emoji being a guessing game
 * everywhere else. Neither alone was enough - text-only made the bar wide and gray, and the earlier
 * icon-only version had a bare ◑ for the palette toggle that nobody could read.
 */
/**
 * The room's status as something to read rather than a column value.
 *
 * Null while the check is still out, and null for 'finished' too - a match that's over is a recap
 * waiting to be read, and labelling the way back to it "finished" reads as "nothing to see".
 */
function roomDoing(status: string | null): string | null {
  if (status === "lobby") return "in the lobby";
  if (status === "placement") return "placing fleets";
  if (status === "battle") return "in battle";
  return null;
}

export function TopBar() {
  const profile = useAuthProfile();
  // Only asked once there's a Twitch session to ask about - this bar is on every page in the app,
  // and admin rights are keyed to a Twitch account, so asking while anonymous is two round trips
  // per page load with a foregone answer. Re-asked on sign-in/out, so the door appears the moment
  // an admin logs in rather than after a reload.
  const { isAdmin } = useAdminStatus(!!profile?.isTwitch);
  const { pathname } = useLocation();
  // Checked against the database, not merely remembered - see useActiveRoom for why a stored code
  // was never evidence that there was anything on the other end of it.
  const activeRoom = useActiveRoom();
  const inThatRoom = activeRoom ? pathname.toUpperCase().startsWith(`/ROOM/${activeRoom.code}`) : false;
  const [volume, setVolumeState] = useState(getVolume);
  // Remembers the level you were at so unmuting restores it instead of guessing a default.
  const [premuteVolume, setPremuteVolume] = useState(() => (getVolume() > 0 ? getVolume() : 0.7));
  const [colorblind, setColorblind] = useState(isColorblindMode);

  const muted = volume === 0;
  // The slider works in whole percent, and the CSS fill is driven off the SAME rounded number -
  // deriving it from the raw float instead would leave the painted track a fraction of a pixel
  // out of step with the thumb.
  const volumePercent = Math.round(volume * 100);

  function applyVolume(v: number) {
    setVolume(v);
    setVolumeState(v);
    if (v > 0) setPremuteVolume(v);
  }

  function toggleMute() {
    applyVolume(muted ? premuteVolume : 0);
  }

  function toggleColorblind() {
    const next = !colorblind;
    setColorblindMode(next);
    setColorblind(next);
  }

  return (
    <div className="tb-bar">
      {/* The bar spans the full width, so it needs an anchor at the far left or it reads as a
          stretched panel with one corner filled. The wordmark is that anchor, and it doubles as the
          only way back to the harbor that's on every screen - the pages that have a "Back to the
          harbor" link each rolled their own, and the room pages only show one in certain states.
          Matches the anchor and wording of the Home page heading exactly, so it reads as the same
          thing rather than as a second, differently-named app. */}
      <Link to="/" className="tb-item tb-brand" title="Back to the harbor">
        <span className="tb-emoji">⚓</span>
        <span className="tb-label">Elden Battleship</span>
      </Link>

      {/* Next to the wordmark, and accented: if you're in a room, getting back to it beats
          everything else in this bar. Only shown when you're somewhere else - the leaderboard, a
          captain's page, the almanac - since those are the screens you can currently reach and not
          return from. */}
      {activeRoom && !inThatRoom && (
        <Link
          to={`/room/${activeRoom.code}`}
          className="tb-item tb-return"
          title={`Back to the room you're in${roomDoing(activeRoom.status) ? ` - ${roomDoing(activeRoom.status)}` : ""}`}
        >
          {/* A plain arrow, not an emoji: this one is a direction, and every emoji that means
              "ship" or "harbor" would read as a destination instead. */}
          <span>← {formatRoomCode(activeRoom.code)}</span>
          {/* What the room is doing, once it's known. Worth the few characters: "still in the
              lobby" and "in battle" are the difference between wandering back at leisure and
              having left a match running. Absent until the check lands, so the bar doesn't
              flicker a word in on load. */}
          {roomDoing(activeRoom.status) && (
            <span className="tb-return-state">{roomDoing(activeRoom.status)}</span>
          )}
        </Link>
      )}

      <span className="tb-spacer" />

      <div className="tb-right">
        {profile?.isTwitch ? (
          <>
            <Link to={`/player/${profile.userId}`} className="tb-item tb-account" title="Your stats">
              {profile.avatarUrl ? (
                <img src={profile.avatarUrl} alt="" width={20} height={20} className="tb-avatar" />
              ) : (
                <span className="tb-emoji">👤</span>
              )}
              {/* Their chosen nickname, not the Twitch one: this is the name everyone else sees on
                  the boards and the leaderboard, so it's the one that belongs next to their avatar. */}
              <span className="tb-account-name">{accountName(profile)}</span>
            </Link>
            {/* Text, not a glyph: ⎋ renders as a "no entry" sign in several fonts, which reads
                as "blocked" rather than "log out". */}
            <button onClick={() => void signOut()} className="tb-item" title="Sign out">
              Sign out
            </button>
          </>
        ) : (
          <button
            onClick={() => void signInWithTwitch()}
            disabled={!isTwitchLoginConfigured}
            className="tb-twitch"
            title="Sign in with Twitch to keep your fleet and track career stats. No permissions requested - not even your email."
          >
            Twitch login
          </button>
        )}

        <span className="tb-sep" />

        <Link
          to="/leaderboard"
          className="tb-item"
          title="Leaderboard - career records across every finished match"
        >
          <span className="tb-emoji">🏆</span>
          <span className="tb-label">Leaderboard</span>
        </Link>
        <Link to="/almanac" className="tb-item" title="Almanac - heatmaps, boss timings and records">
          <span className="tb-emoji">📖</span>
          <span className="tb-label">Almanac</span>
        </Link>

        {/* Only for admins, and only once the check has come back - rendering it while `loading`
            would flash a control at every visitor for the length of a round trip. This is not a
            security boundary (RLS is); the page behind it makes the same check for anyone who
            types the URL. Tinted like the panel's own heading so it reads as the one item in this
            bar that isn't for everybody. */}
        {isAdmin && (
          <Link to="/admin" className="tb-item tb-admin" title="Admin - records, live rooms and administrators">
            <span className="tb-emoji">🛠️</span>
            <span className="tb-label">Admin</span>
          </Link>
        )}

        <span className="tb-sep" />

        {/* As a bare ◑ this looked broken: it only recolors TEAMS, so on any screen without a board
            or roster it appears to do nothing at all. Saying "on/off" gives it visible feedback
            everywhere, and the accent border does the same job when the label is hidden.

            Ahead of the sound controls so that the two plain toggles sit together and the slider
            ends the bar: with it in the middle, the volume track split the button pair and left the
            colorblind toggle marooned on the far end of a control it has nothing to do with. */}
        <button
          onClick={toggleColorblind}
          aria-pressed={colorblind}
          className={`tb-item${colorblind ? " tb-colorblind-on" : ""}`}
          title="Colorblind mode - swaps the default red/blue fleets for a colorblind-safe blue/orange pair. Affects boards, rosters and the leaderboard."
        >
          <span className="tb-emoji">🎨</span>
          <span className="tb-label">Colorblind {colorblind ? "on" : "off"}</span>
        </button>

        {/* Both toggles state the CURRENT state ("Sound on") rather than the action ("Mute") -
            mixing the two conventions side by side is what makes toolbars ambiguous about whether a
            label describes what is, or what clicking will do. The speaker emoji says the same thing
            a second way, which is what keeps the toggle readable once the label is hidden. */}
        <button
          onClick={toggleMute}
          aria-pressed={muted}
          className={`tb-item${muted ? "" : " tb-on"}`}
          title={muted ? "Sound is off - click to turn it on" : "Sound is on - click to turn it off"}
        >
          <span className="tb-emoji">{muted ? "🔇" : "🔊"}</span>
          <span className="tb-label">Sound {muted ? "off" : "on"}</span>
        </button>
        {/* Kept next to its own toggle rather than swapped across with it - a volume track adrift
            from the speaker it controls is a worse bar than either ordering. */}
        <input
          type="range"
          min={0}
          max={100}
          value={volumePercent}
          onChange={(e) => applyVolume(Number(e.target.value) / 100)}
          aria-label="Sound effect volume"
          className="tb-slider"
          // A range input offers no hook for colouring the track up to the thumb, so the fill is
          // painted in CSS from this fraction. See TopBar.css for why it's 0-1 and not a percent.
          style={{ ["--tb-fill" as string]: volumePercent / 100 }}
        />
      </div>
    </div>
  );
}
