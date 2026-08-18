/**
 * What this is, and how to reach the person who made it.
 *
 * Two lines, deliberately. This sits on a page whose job is getting people into a match, and almost
 * everyone reading it is a runner about to join a room rather than a developer deciding whether to
 * fork the project. So the invitation is reduced to a link: the few people it is written for will
 * click it, and everyone else can ignore it without reading a paragraph aimed at somebody else.
 *
 * There is deliberately no copyright line or licence name here. It used to carry both, and neither
 * did any work on this page - the licence lives in LICENSE where anyone who cares will look, and a
 * copyright notice on a fan project's front page is posturing. What replaced them is the only part
 * that was ever worth saying out loud: if you're using it, get in touch.
 *
 * The disclaimer is the line that earns its place outright. Fan projects live on tolerance rather
 * than on licences, and saying plainly what this is not costs almost nothing.
 *
 * Not shown during placement or battle, for the same reason CommunityLinks isn't: a link that
 * navigates away from a live match is a hazard.
 */
export function SiteFooter() {
  return (
    <div
      className="stack"
      style={{
        gap: "0.25rem",
        marginTop: "0.5rem",
        paddingTop: "0.6rem",
        borderTop: "1px solid var(--panel-border)",
        fontSize: "0.7rem",
        lineHeight: 1.5,
        color: "var(--text-dim)",
        textAlign: "center",
      }}
    >
      <span>
        Free and open source &middot; using it for something?{" "}
        <a href="https://github.com/kcbrazos" target="_blank" rel="noreferrer">
          Say hello
        </a>
      </span>

      <span style={{ opacity: 0.75 }}>
        Unofficial fan project. Not affiliated with FromSoftware or Bandai Namco.
      </span>
    </div>
  );
}
