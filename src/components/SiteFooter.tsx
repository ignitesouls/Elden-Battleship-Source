import { useT } from "../lib/language";
import "./SiteFooter.css";

/**
 * The one line at the bottom of a menu page.
 *
 * This used to carry three link chips as well. They are in the top bar now - see OutreachLinks - for
 * the reason a footer is a bad home for them: it is only reached by somebody who has already scrolled
 * past everything they came for, which made the bug report hardest to find at the exact moment it
 * was worth most.
 *
 * The disclaimer did not go up with them, because it is the wrong shape for a toolbar. Nobody reads
 * a legal note in a strip of controls, and it does not need to be read at a glance - it needs to be
 * present. The bottom of the page is where a reader looks for it and where it costs nothing.
 *
 * There is deliberately no copyright line or licence name beside it. Both used to sit here and
 * neither did any work - there is no licence to name, copyright applies without a notice, and a
 * copyright line on a fan project's front page is posturing. The disclaimer is the part that earns
 * its place outright: fan projects live on tolerance rather than on licences, and saying plainly what
 * this is not costs almost nothing.
 *
 * Still not mounted during placement or battle. That was once about the links being a hazard mid-
 * match; it is now simply that those screens are a board and a clock, and neither has a bottom of
 * the page to put anything at.
 */
export function SiteFooter() {
  const t = useT();
  return (
    <div className="site-footer">
      <span className="foot-fine">
        {t(
          "Unofficial fan project, not affiliated with FromSoftware or Bandai Namco.",
          "Projet de fan non officiel, sans lien avec FromSoftware ou Bandai Namco."
        )}
      </span>
    </div>
  );
}
