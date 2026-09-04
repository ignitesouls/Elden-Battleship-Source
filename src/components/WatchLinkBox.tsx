import { useEffect, useState } from "react";
import { useAuthProfile } from "../hooks/useAuthProfile";
import { fetchMyWatchLink, setWatchShowFleet, watchUrl } from "../lib/watchStream";
// For .obs-token and .obs-pick. Imported here rather than relied on from the page that renders this,
// so the box keeps its own styling if it is ever dropped somewhere else.
import "../pages/Streaming.css";

/**
 * The link a streamer gives their audience, and the one switch under it.
 *
 * -- Why this is on the OBS page ------------------------------------------------------------------
 *
 * Same errand as the other two things here: set up once, on the day somebody decides to stream this
 * game, and then never touched again. It is not a match setting and it is not a profile setting - it
 * is a thing you paste into Twitch alongside the scene you just downloaded.
 *
 * -- Why there is nothing to generate --------------------------------------------------------------
 *
 * Every other credential on this page has a button that mints it. This one has no button because
 * there is nothing to mint: the address is the streamer's Twitch name, which they already have, and
 * which is unique and URL-safe because Twitch made it so. Nothing to claim, nothing to squat,
 * nothing to rotate, and nothing to lose. It works the moment they sign in.
 *
 * That is also why it is not a secret and is not masked the way the overlay token is. It is meant to
 * be broadcast. What keeps it safe is what it can REACH - a room code, a status, a team and a name -
 * rather than who knows it.
 */
export function WatchLinkBox() {
  const viewer = useAuthProfile();
  const signedIn = Boolean(viewer?.isTwitch);

  /** `undefined` while loading, `null` for an account with no handle to build a link from. */
  const [handle, setHandle] = useState<string | null | undefined>(undefined);
  const [showFleet, setShowFleet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!signedIn) {
      setHandle(null);
      return;
    }
    let cancelled = false;
    void fetchMyWatchLink().then((mine) => {
      if (cancelled) return;
      setHandle(mine?.handle ?? null);
      setShowFleet(mine?.showFleet ?? false);
    });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  /**
   * The switch, written straight through rather than staged behind a Save.
   *
   * This is a control over who can see the streamer's ships, and the state it is in has to be the
   * state it is actually in - a checkbox holding an unsaved "off" while the database still says on
   * would be the most dangerous possible way to draw it. Optimistic, then reverted if the write
   * fails, so the box never claims something the server did not accept.
   */
  async function toggleFleet(next: boolean) {
    setBusy(true);
    setError(null);
    setShowFleet(next);
    try {
      await setWatchShowFleet(next);
    } catch (err) {
      setShowFleet(!next);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Built from window.location so the link is right on localhost and under the GitHub Pages base -
  // same reasoning as the scene URLs above it.
  const base = `${window.location.origin}${window.location.pathname}`;
  const url = handle ? watchUrl(base, handle) : null;

  function copy() {
    if (!url) return;
    navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="panel stack" style={{ gap: "0.6rem", padding: "0.7rem" }}>
      <strong style={{ fontSize: "0.86rem" }}>Watch link for your audience</strong>

      <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
        One link, for your panel or a <code>!watch</code> command. It always opens whatever match
        you're in right now, from your seat - your hunting board and your fleet, the same two boards
        you're playing off. It never goes stale, so you paste it once.
      </span>

      {/*
        Said here rather than left to be inferred, because it is the reason to hand this out instead
        of a room link - and because a streamer needs to be able to tell their chat what it is.
      */}
      <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
        Viewers who follow it <strong>cannot see the other side</strong>. They don't join the room,
        and reading anyone's ship positions needs a seat in it - so there's no setting for them to
        find and nothing for you to police in chat.
      </span>

      {!signedIn ? (
        <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
          Sign in with Twitch to get one. The link is your Twitch name, so there's nothing to set up
          - and an anonymous account has no permanent name to give out.
        </span>
      ) : handle === undefined ? (
        <span className="muted" style={{ fontSize: "0.72rem" }}>Loading...</span>
      ) : handle === null ? (
        <span className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
          Your Twitch name hasn't reached your profile yet. Sign out and back in once and it'll be
          here.
        </span>
      ) : (
        <>
          <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap", alignItems: "center" }}>
            <code className="obs-token">{url}</code>
            <button onClick={copy} style={{ fontSize: "0.74rem" }}>
              {copied ? "Copied!" : "Copy"}
            </button>
            {/* Non-null because this branch only renders once `handle` is a string, which is the
                one thing `url` is derived from - TypeScript cannot see the two are the same test. */}
            <a href={url!} target="_blank" rel="noreferrer" style={{ fontSize: "0.74rem" }}>
              Open
            </a>
          </div>

          {/*
            The one decision on this box, and the warning sits on the control rather than three
            paragraphs up - the moment the box is ticked is the moment it has to be readable. Same
            placement, and the same red, as the ships warning on the OBS source list.
          */}
          <label className="obs-pick">
            <input
              type="checkbox"
              checked={showFleet}
              disabled={busy}
              onChange={(e) => void toggleFleet(e.target.checked)}
            />
            <span className="stack" style={{ gap: "0.1rem" }}>
              <span style={{ fontSize: "0.76rem" }}>Show my ships to viewers</span>
              <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
                Off, your fleet board still shows every hit, miss and sinking you take - just not
                where the hulls are.
              </span>
              {showFleet && (
                <span style={{ fontSize: "0.68rem", lineHeight: 1.35, color: "var(--hit)" }}>
                  <strong>
                    This link is public, so your opponent can open it too. With this on, they can see
                    exactly where your ships are.
                  </strong>
                </span>
              )}
            </span>
          </label>
        </>
      )}

      {error && (
        <span style={{ fontSize: "0.72rem", color: "var(--hit)" }} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
