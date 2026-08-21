import { PatchesMark } from "./HitMarkers";
// Patches' own colours live in BoardGrid.css alongside the rest of the board markers. Imported here
// for the same reason the overlay pages import it: this component is reachable on menu screens that
// never mount a board, and the drawing without its stylesheet is a stack of black paths.
import "./BoardGrid.css";
import "./SiteFooter.css";

// Through BASE_URL like every other public asset here (see BrandMark, shipArt, sfx): the site is
// served from a subpath on Pages, so a root-absolute "/ignite_logo.png" resolves above the app and
// 404s everywhere except a local server that happens to sit at the domain root.
const LOGO = `${import.meta.env.BASE_URL}ignite_logo.png`;

/**
 * What this is, and the three ways to reach somebody about it.
 *
 * These were three sentences with links buried in them, which is the wrong shape for a footer:
 * nobody reads one, they scan it for something to click. So each one is a chip with a picture on
 * it - the picture is what gets found at a glance, and the label confirms it. The copy is the same
 * length it was; it just stopped pretending to be prose.
 *
 * There is deliberately no copyright line or licence name here. Both used to sit at the bottom and
 * neither did any work - the licence lives in LICENSE where anyone who cares will look, and a
 * copyright notice on a fan project's front page is posturing.
 *
 * The disclaimer is the line that earns its place outright. Fan projects live on tolerance rather
 * than on licences, and saying plainly what this is not costs almost nothing.
 *
 * Not shown during placement or battle: a link that navigates away from a live match is a hazard,
 * and nobody mid-game is shopping for a Discord invite. This is also now the only place the Discord
 * invite lives - it used to be a full-width button of its own on the menu and the lobby, which meant
 * two Discord links stacked on those two screens and none anywhere else.
 */
export function SiteFooter() {
  return (
    <div className="site-footer">
      <div className="foot-links">
        {/* A plain anchor rather than a <Link>, and a new tab, so that this being at the bottom of a
            lobby cannot cost somebody the room they are sitting in. The hash route works either way. */}
        <a className="foot-btn foot-btn-bug" href="#/support" target="_blank" rel="noreferrer">
          <span className="foot-icon" aria-hidden="true">
            <BugMark />
          </span>
          <span>Report a bug</span>
        </a>

        <a
          className="foot-btn foot-btn-hello"
          href="https://github.com/kcbrazos"
          target="_blank"
          rel="noreferrer"
        >
          {/* Patches, because the greeting on this one is the point and he is already the site's
              drawing of somebody waving at you out of the water. The water tile behind him is not
              decoration - see .foot-icon-water. */}
          <span className="foot-icon foot-icon-water" aria-hidden="true">
            <PatchesMark />
          </span>
          <span>Say hello</span>
        </a>

        <a
          className="foot-btn foot-btn-discord"
          href="https://discord.com/invite/ignitesouls"
          // noreferrer alongside noopener since this one leaves for a third party entirely.
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="foot-icon" aria-hidden="true">
            <img src={LOGO} alt="" width={24} height={24} />
          </span>
          <span>Join Ignite on Discord!</span>
        </a>
      </div>

      <span className="foot-fine">
        Free and open source. Unofficial fan project, not affiliated with FromSoftware or Bandai
        Namco.
      </span>
    </div>
  );
}

/**
 * A beetle on its way out of the frame.
 *
 * Drawn here rather than in HitMarkers because that file is the board's vocabulary - things that
 * happen to a square - and this is chrome. It shares the house style anyway: heavy dark strokes and
 * flat fills, so it sits next to Patches without looking like it came from a different site.
 *
 * The legs are a separate group from the body so that only they move on hover. A bug that scuttles
 * while its shell stays put reads as alive; scaling the whole drawing reads as a logo animating.
 */
function BugMark() {
  return (
    <svg viewBox="0 0 100 100" className="foot-bug" aria-hidden="true">
      <g className="foot-bug-legs">
        <path className="foot-bug-limb" d="M28,42 L10,32" />
        <path className="foot-bug-limb" d="M26,58 L6,58" />
        <path className="foot-bug-limb" d="M28,74 L11,86" />
        <path className="foot-bug-limb" d="M72,42 L90,32" />
        <path className="foot-bug-limb" d="M74,58 L94,58" />
        <path className="foot-bug-limb" d="M72,74 L89,86" />
        <path className="foot-bug-limb" d="M42,17 C36,8 28,5 21,7" />
        <path className="foot-bug-limb" d="M58,17 C64,8 72,5 79,7" />
      </g>
      <circle className="foot-bug-head" cx="50" cy="26" r="14" />
      <ellipse className="foot-bug-shell" cx="50" cy="60" rx="26" ry="32" />
      {/* The seam is what makes an oval read as a beetle's back rather than as a pebble - the same
          job the brows do on Patches once the drawing shrinks. */}
      <path className="foot-bug-seam" d="M50,30 L50,90" />
      <circle className="foot-bug-spot" cx="37" cy="52" r="5" />
      <circle className="foot-bug-spot" cx="63" cy="52" r="5" />
      <circle className="foot-bug-spot" cx="39" cy="72" r="4" />
      <circle className="foot-bug-spot" cx="61" cy="72" r="4" />
      <circle className="foot-bug-eye" cx="44" cy="24" r="2.6" />
      <circle className="foot-bug-eye" cx="56" cy="24" r="2.6" />
    </svg>
  );
}
