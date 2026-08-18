/** Injected by Vite's `define` at build time - see buildId() in vite.config.ts. */
declare const __BUILD_ID__: string;

/**
 * The build identifier, parked in the bottom-left corner.
 *
 * Purely a support tool: when someone's client is behaving oddly, the first question is whether
 * they're running the current bundle at all, and GitHub Pages' aggressive index.html caching means
 * the honest answer is often "no". Comparing this string beats guessing.
 *
 * It used to carry a copyright line too, on the reasoning that this is the one element already
 * tiny and out of the way enough to host one. That was solving a problem nobody had - the licence
 * is in LICENSE, and a notice burned into the corner of every screen of a fan project was never
 * doing any work. The build id is the part that earns its place.
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
      build {__BUILD_ID__}
    </div>
  );
}
