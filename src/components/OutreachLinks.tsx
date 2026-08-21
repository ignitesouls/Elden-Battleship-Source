import { PatchesMark } from "./HitMarkers";
// Patches' own colours live in BoardGrid.css alongside the rest of the board markers. Imported here
// for the same reason the overlay pages import it: the top bar is on menu screens that never mount
// a board, and the drawing without its stylesheet is a stack of black paths.
import "./BoardGrid.css";
import "./OutreachLinks.css";

// Through BASE_URL like every other public asset here (see BrandMark, shipArt, sfx): the site is
// served from a subpath on Pages, so a root-absolute "/ignite_logo.png" resolves above the app and
// 404s everywhere except a local server that happens to sit at the domain root.
const LOGO = `${import.meta.env.BASE_URL}ignite_logo.png`;

/**
 * The three ways to reach somebody about this, as items in the top bar.
 *
 * These used to be chips at the bottom of every menu page. The trouble with a footer is that it is
 * only ever seen by somebody who has already scrolled past everything they came for - so the bug
 * report, which is worth most at the exact moment something has gone wrong, was the hardest thing
 * on the site to find. In the bar they are on screen the whole time.
 *
 * Styled as bar items rather than as the pill buttons they were: this is chrome now, sitting between
 * the wordmark and the account controls, and three coloured pills in the middle of a toolbar would
 * outshout every control around them. The picture is what gets found at a glance and the label
 * confirms it, which is the same bargain every other control in this bar makes.
 *
 * -- Who sees the social two -----------------------------------------------------------------
 *
 * `inLiveMatch` hides "Say hello" and Discord, and it is deliberately not the same thing as "is a
 * match happening". A spectator watching a battle keeps them: they are a viewer, an off-site link
 * costs them nothing, and the Discord invite is worth most to somebody who has just found the site
 * by watching it. A PLAYER mid-battle loses them, because a link that navigates away from a live
 * match is a hazard and nobody placing a fleet is shopping for an invite.
 *
 * The bug report is exempt and shows to everybody, always. It is the one link whose worth goes UP
 * during a match - that is when a bug happens - and it opens in a new tab, so it cannot cost you the
 * room you are sitting in.
 */
export function OutreachLinks({ inLiveMatch }: { inLiveMatch: boolean }) {
  return (
    <div className="tb-outreach">
      {/* Plain anchors and a new tab, all three: this is on every screen now, including one with a
          live match on it, so none of them may replace what is in the window. The hash route works
          either way. */}
      <a
        className="tb-item tb-out tb-out-bug"
        href="#/support"
        target="_blank"
        rel="noreferrer"
        title="Report a bug. (Opens in a new tab)"
      >
        <span className="tb-out-icon" aria-hidden="true">
          <BugMark />
        </span>
        <span className="tb-label">Report a bug</span>
      </a>

      {!inLiveMatch && (
        <>
          <a
            className="tb-item tb-out tb-out-hello"
            href="https://github.com/kcbrazos"
            target="_blank"
            rel="noreferrer"
            title="Like the game? Let me know!"
          >
            {/* Patches, because the greeting is the point and he is already the site's drawing of
                somebody waving at you out of the water. The water tile behind him is not decoration
                - see .tb-out-water. */}
            <span className="tb-out-icon tb-out-water" aria-hidden="true">
              <PatchesMark />
            </span>
            <span className="tb-label">Say hello</span>
          </a>

          <a
            className="tb-item tb-out tb-out-discord"
            href="https://discord.com/invite/ignitesouls"
            // noreferrer alongside noopener since this one leaves for a third party entirely.
            target="_blank"
            rel="noopener noreferrer"
            title="Join Ignite on Discord"
          >
            <span className="tb-out-icon" aria-hidden="true">
              <img src={LOGO} alt="" width={20} height={20} />
            </span>
            {/* "Join Ignite on Discord!" was the right length for a footer chip and is far too long
                for a toolbar. The logo and the tooltip both still say Ignite. */}
            <span className="tb-label">Discord</span>
          </a>
        </>
      )}
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
    <svg viewBox="0 0 100 100" className="tb-out-beetle" aria-hidden="true">
      <g className="tb-out-legs">
        <path className="tb-out-limb" d="M28,42 L10,32" />
        <path className="tb-out-limb" d="M26,58 L6,58" />
        <path className="tb-out-limb" d="M28,74 L11,86" />
        <path className="tb-out-limb" d="M72,42 L90,32" />
        <path className="tb-out-limb" d="M74,58 L94,58" />
        <path className="tb-out-limb" d="M72,74 L89,86" />
        <path className="tb-out-limb" d="M42,17 C36,8 28,5 21,7" />
        <path className="tb-out-limb" d="M58,17 C64,8 72,5 79,7" />
      </g>
      <circle className="tb-out-head" cx="50" cy="26" r="14" />
      <ellipse className="tb-out-shell" cx="50" cy="60" rx="26" ry="32" />
      {/* The seam is what makes an oval read as a beetle's back rather than as a pebble - the same
          job the brows do on Patches once the drawing shrinks. */}
      <path className="tb-out-seam" d="M50,30 L50,90" />
      <circle className="tb-out-spot" cx="37" cy="52" r="5" />
      <circle className="tb-out-spot" cx="63" cy="52" r="5" />
      <circle className="tb-out-spot" cx="39" cy="72" r="4" />
      <circle className="tb-out-spot" cx="61" cy="72" r="4" />
      <circle className="tb-out-eye" cx="44" cy="24" r="2.6" />
      <circle className="tb-out-eye" cx="56" cy="24" r="2.6" />
    </svg>
  );
}
