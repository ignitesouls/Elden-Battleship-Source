/** Injected by Vite's `define` at build time - see buildId() in vite.config.ts. */
declare const __BUILD_ID__: string;

/**
 * The build identifier and the copyright line, parked in the bottom-left corner.
 *
 * The build id is purely a support tool: when someone's client is behaving oddly, the first
 * question is whether they're running the current bundle at all, and GitHub Pages' aggressive
 * index.html caching means the honest answer is often "no". Comparing this string beats guessing.
 *
 * The copyright rides along with it because this is the one element on every screen that is
 * already tiny, dim and out of the way. It is deliberately NOT on the overlay routes: those get
 * composited onto somebody's stream, and a copyright line burned into a broadcast is nobody's
 * idea of a good time. App.tsx's Chrome is what keeps it off them.
 *
 * Kept dim and tiny so it never competes with the board, and selectable so the build id can be
 * pasted straight into chat.
 */
export function BuildStamp() {
  return (
    <div
      title="Build version. If someone's game is out of sync, compare these and hard-refresh (Ctrl+Shift+R)."
      style={{
        position: "fixed",
        left: "0.5rem",
        bottom: "0.35rem",
        // Below the toolbar (30) and any dialogs, so it can never intercept a real interaction.
        zIndex: 1,
        fontSize: "0.62rem",
        lineHeight: 1,
        color: "var(--text-dim)",
        opacity: 0.45,
        fontVariantNumeric: "tabular-nums",
        // Left interactive (rather than click-through) so the title tooltip works - the corner is
        // empty on every screen, so there's nothing underneath for it to steal a click from.
        userSelect: "text",
      }}
    >
      build {__BUILD_ID__} · &copy; {new Date().getFullYear()} KCBrazos
    </div>
  );
}
