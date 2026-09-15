import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useActiveRoom } from "../hooks/useActiveRoom";
import { formatRoomCode } from "../lib/roomCode";
import { getVolume, setVolume, isDeepSfx, setDeepSfx } from "../lib/sfx";
import { isColorblindMode, setColorblindMode } from "../lib/teamColors";
import { isTwitchLoginConfigured, signInWithTwitch, signOut } from "../lib/supabase";
import { useAuthProfile, accountName } from "../hooks/useAuthProfile";
import { useAdminStatus } from "../lib/admin";
import { useLanguage, setLanguage, useT } from "../lib/language";
import { OutreachLinks } from "./OutreachLinks";
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
function roomDoing(status: string | null, t: (en: string, fr: string) => string): string | null {
  if (status === "lobby") return t("in the lobby", "dans le lobby");
  if (status === "placement") return t("placing fleets", "en placement des flottes");
  if (status === "battle") return t("in battle", "en bataille");
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
  // Playing in a live match, as opposed to watching one. Both halves matter: `inThatRoom` is what
  // separates a player from a spectator - an active room is only ever stored for somebody who has a
  // player in it (see Room.tsx) - and the status is what separates a match from a lobby, where an
  // off-site link is welcome and always has been.
  //
  // A null status means the check is still out or a read failed, and that resolves to `false` here
  // on purpose: it is the same call useActiveRoom makes for the return link just above, where the
  // reasoning is spelled out. Not knowing is not evidence, and the cost of being wrong for one round
  // trip is a link that was on screen a moment longer than it should have been.
  const playingLiveMatch =
    inThatRoom && (activeRoom?.status === "placement" || activeRoom?.status === "battle");
  const [volume, setVolumeState] = useState(getVolume);
  // Remembers the level you were at so unmuting restores it instead of guessing a default.
  const [premuteVolume, setPremuteVolume] = useState(() => (getVolume() > 0 ? getVolume() : 0.7));
  const [colorblind, setColorblind] = useState(isColorblindMode);
  const [deep, setDeep] = useState(isDeepSfx);
  const lang = useLanguage();
  const t = useT();

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

  function toggleDeep() {
    const next = !deep;
    setDeepSfx(next);
    setDeep(next);
  }

  function toggleLanguage() {
    setLanguage(lang === "fr" ? "en" : "fr");
  }

  return (
    <div className="tb-bar">
      {/* The bar spans the full width, so it needs an anchor at the far left or it reads as a
          stretched panel with one corner filled. The wordmark is that anchor, and it doubles as the
          only way back to the harbor that's on every screen - the pages that have a "Back to the
          harbor" link each rolled their own, and the room pages only show one in certain states.
          Matches the anchor and wording of the Home page heading exactly, so it reads as the same
          thing rather than as a second, differently-named app. */}
      <Link to="/" className="tb-item tb-brand" title={t("Back to the harbor", "Retour au port")}>
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
          title={`${t("Back to the room you're in", "Retour à votre partie")}${roomDoing(activeRoom.status, t) ? ` - ${roomDoing(activeRoom.status, t)}` : ""}`}
        >
          {/* A plain arrow, not an emoji: this one is a direction, and every emoji that means
              "ship" or "harbor" would read as a destination instead. */}
          <span>← {formatRoomCode(activeRoom.code)}</span>
          {/* What the room is doing, once it's known. Worth the few characters: "still in the
              lobby" and "in battle" are the difference between wandering back at leisure and
              having left a match running. Absent until the check lands, so the bar doesn't
              flicker a word in on load. */}
          {roomDoing(activeRoom.status, t) && (
            <span className="tb-return-state">{roomDoing(activeRoom.status, t)}</span>
          )}
        </Link>
      )}

      <span className="tb-spacer" />

      {/* Between the two spacers, so it sits in the middle of the bar rather than crowding either
          the wordmark or the account controls. It is the one group here that is about the project
          rather than about the app, and the gap on both sides is what says so. */}
      <OutreachLinks inLiveMatch={playingLiveMatch} />

      <span className="tb-spacer" />

      <div className="tb-right">
        {profile?.isTwitch ? (
          <>
            <Link to={`/player/${profile.userId}`} className="tb-item tb-account" title={t("Your stats", "Vos statistiques")}>
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
            <button onClick={() => void signOut()} className="tb-item" title={t("Sign out", "Se déconnecter")}>
              {t("Sign out", "Se déconnecter")}
            </button>
          </>
        ) : (
          <button
            onClick={() => void signInWithTwitch()}
            disabled={!isTwitchLoginConfigured}
            className="tb-twitch"
            title={t(
              "Sign in with Twitch to keep your fleet and track career stats. It asks for no permissions, not even your email.",
              "Connectez-vous avec Twitch pour conserver votre flotte et suivre vos statistiques de carrière. Aucune permission n'est demandée, pas même votre e-mail."
            )}
          >
            {t("Twitch login", "Connexion Twitch")}
          </button>
        )}

        <span className="tb-sep" />

        <Link
          to="/leaderboard"
          className="tb-item"
          title={t("Leaderboard - career records across every finished match", "Classement - records de carrière sur toutes les parties terminées")}
        >
          <span className="tb-emoji">🏆</span>
          <span className="tb-label">{t("Leaderboard", "Classement")}</span>
        </Link>
        <Link to="/almanac" className="tb-item" title={t("Almanac - heatmaps, boss timings and records", "Almanach - cartes de chaleur, temps de boss et records")}>
          <span className="tb-emoji">📖</span>
          <span className="tb-label">{t("Almanac", "Almanach")}</span>
        </Link>

        {/* Only for admins, and only once the check has come back - rendering it while `loading`
            would flash a control at every visitor for the length of a round trip. This is not a
            security boundary (RLS is); the page behind it makes the same check for anyone who
            types the URL. Tinted like the panel's own heading so it reads as the one item in this
            bar that isn't for everybody. */}
        {isAdmin && (
          <Link to="/admin" className="tb-item tb-admin" title={t("Admin - records, live rooms and administrators", "Admin - records, parties en direct et administrateurs")}>
            <span className="tb-emoji">🛠️</span>
            <span className="tb-label">{t("Admin", "Admin")}</span>
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
          title={t(
            "Colorblind mode - blue and orange fleets instead of red and blue, on boards, rosters and the leaderboard.",
            "Mode daltonien - flottes bleue et orange au lieu de rouge et bleu, sur les plateaux, les listes d'équipage et le classement."
          )}
        >
          <span className="tb-emoji">🎨</span>
          <span className="tb-label">{t("Colorblind", "Daltonien")} {colorblind ? t("on", "activé") : t("off", "désactivé")}</span>
        </button>

        {/* The language toggle sits here, between colorblind and sound, so the three "how this app
            presents itself to you" preferences stay grouped in one run rather than being split
            across the bar. */}
        <button
          onClick={toggleLanguage}
          aria-pressed={lang === "fr"}
          className={`tb-item${lang === "fr" ? " tb-on" : ""}`}
          title={t("Switch to French", "Passer à l'anglais")}
        >
          <span className="tb-emoji">🌐</span>
          <span className="tb-label">{lang === "fr" ? "Français" : "English"}</span>
        </button>

        {/* Both toggles state the CURRENT state ("Sound on") rather than the action ("Mute") -
            mixing the two conventions side by side is what makes toolbars ambiguous about whether a
            label describes what is, or what clicking will do. The speaker emoji says the same thing
            a second way, which is what keeps the toggle readable once the label is hidden. */}
        <button
          onClick={toggleMute}
          aria-pressed={muted}
          className={`tb-item${muted ? "" : " tb-on"}`}
          title={muted ? t("Turn sound on", "Activer le son") : t("Turn sound off", "Désactiver le son")}
        >
          <span className="tb-emoji">{muted ? "🔇" : "🔊"}</span>
          <span className="tb-label">{t("Sound", "Son")} {muted ? t("off", "désactivé") : t("on", "activé")}</span>
        </button>
        {/* Kept next to its own toggle rather than swapped across with it - a volume track adrift
            from the speaker it controls is a worse bar than either ordering. */}
        <input
          type="range"
          min={0}
          max={100}
          value={volumePercent}
          onChange={(e) => applyVolume(Number(e.target.value) / 100)}
          aria-label={t("Sound effect volume", "Volume des effets sonores")}
          className="eb-slider tb-slider"
          // A range input offers no hook for colouring the track up to the thumb, so the fill is
          // painted in CSS from this fraction. See .eb-slider in index.css for why it's 0-1 and not
          // a percent.
          style={{ ["--eb-fill" as string]: volumePercent / 100 }}
        />
        {/* Subordinate to the speaker, and placed AFTER the slider rather than between the two, so
            the mute and its own track stay welded together - see the note on the slider above.

            It only ever takes away. Turning it off leaves every shot, horn and closing sting exactly
            as they were and silences what the water gives up, which on a board where Igon has been
            found is fifteen seconds of shouting per crew that fires at his square. The master
            toggle still covers both kinds, so this is never the reason the app is silent.

            "The Deep" rather than "easter eggs" because that is what the recap panel, the record
            books and the stream's find alert already call these; a bar that invented a second name
            for them would be the only place in the app using it.

            The octopus stays put in both states instead of swapping for a crossed-out glyph, since
            it is the only thing naming WHICH sounds this governs once TopBar.css hides the label -
            it greys out instead, and the title says the rest. */}
        <button
          onClick={toggleDeep}
          aria-pressed={!deep}
          className={`tb-item${deep ? " tb-on" : " tb-deep-off"}`}
          title={
            deep
              ? t(
                  "Turn off the Deep's sounds - whales, the Dutchman, tentacles, bottles, Alexander and Igon. Shots, horns and the final sting are unaffected.",
                  "Désactiver les sons des Profondeurs - baleines, le Hollandais, tentacules, bouteilles, Alexander et Igon. Les tirs, cornes et le générique final ne sont pas affectés."
                )
              : t(
                  "Turn the Deep's sounds back on - whales, the Dutchman, tentacles, bottles, Alexander and Igon",
                  "Réactiver les sons des Profondeurs - baleines, le Hollandais, tentacules, bouteilles, Alexander et Igon"
                )
          }
        >
          <span className="tb-emoji">🐙</span>
          <span className="tb-label">{t("Deep sounds", "Sons des Profondeurs")} {deep ? t("on", "activés") : t("off", "désactivés")}</span>
        </button>
      </div>
    </div>
  );
}
