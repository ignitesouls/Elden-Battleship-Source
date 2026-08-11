import type { ReactNode } from "react";
import "./BrandMark.css";

/**
 * The wordmark at in-app sizes, and the loading screen that uses it.
 *
 * Deliberately not the hero file from the home page: this one is the 320px export, because the
 * screens it appears on are the ones you reach on a cold load or a slow connection. See
 * scripts/build-logo-assets.mjs.
 */
const SRC = `${import.meta.env.BASE_URL}logo-small.png`;

interface MarkProps {
  /** Any CSS length. The height follows from the art's own ratio. */
  width?: string;
  dim?: boolean;
  /**
   * Set where the logo sits next to text that already names the app or the screen - a loading
   * message, the error panel's heading. It empties the alt attribute, so a screen reader skips
   * the image instead of announcing "Elden Battleship" ahead of the sentence that matters.
   */
  decorative?: boolean;
}

export function BrandMark({ width = "10rem", dim = false, decorative = false }: MarkProps) {
  return (
    <img
      src={SRC}
      alt={decorative ? "" : "Elden Battleship"}
      width={320}
      height={204}
      className={`brand-mark${dim ? " brand-mark-dim" : ""}`}
      style={{ width }}
    />
  );
}

/**
 * What a screen shows while it's waiting on the server.
 *
 * These were a bare line of grey text, which is indistinguishable from a page that has finished
 * loading and simply has nothing on it - the complaint was always "it just says loading" rather
 * than "it's slow". The mark gives the wait a shape, and the pulse says the tab is still alive.
 */
export function LoadingScreen({ children }: { children: ReactNode }) {
  return (
    <div className="brand-loading">
      <BrandMark width="9rem" decorative />
      {/* aria-live so a screen reader announces the wait when this replaces the previous screen;
          without it the swap is silent and the page just appears to stop responding. */}
      <p className="muted" aria-live="polite">
        {children}
      </p>
    </div>
  );
}
