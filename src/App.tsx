import { Suspense, lazy } from "react";
import { HashRouter, Routes, Route, useLocation } from "react-router-dom";
import { Home } from "./pages/Home";
import { Room } from "./pages/Room";
import { Overlay } from "./pages/Overlay";
import { OverlayBoard } from "./pages/OverlayBoard";
import { OverlayTimer } from "./pages/OverlayTimer";
import { OverlayKey } from "./pages/OverlayKey";
import { OverlayAudio } from "./pages/OverlayAudio";
import { OverlayFleet } from "./pages/OverlayFleet";
import { OverlayEgg } from "./pages/OverlayEgg";
import { OverlayOdds } from "./pages/OverlayOdds";
import { CasterControl } from "./pages/CasterControl";
import { StreamSource } from "./pages/StreamSource";
import { TopBar } from "./components/TopBar";
import { BuildStamp } from "./components/BuildStamp";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LoadingScreen } from "./components/BrandMark";

/**
 * The browsing pages, fetched on demand rather than baked into the bundle everything else loads.
 *
 * Every route above is a page somebody is in the middle of a match on - the join form, the room
 * itself, the five OBS browser sources, and the caster's desk - and those stay eagerly imported so
 * that nothing on a game path can ever wait on a network round trip it didn't used to wait on.
 *
 * These five are the opposite: they are read between matches, and between them they drag in the
 * record book, the almanac, the career-stats and scouting passes, the match replayer, the archive
 * reader and the admin panel - none of which a player firing at a board ever touches. Loading them
 * with the game meant every player's browser, and every OBS browser source on the streamer's PC,
 * parsed and compiled the lot on the way to a page that would never call any of it.
 */
const Leaderboard = lazy(() => import("./pages/Leaderboard").then((m) => ({ default: m.Leaderboard })));
const PlayerStats = lazy(() => import("./pages/PlayerStats").then((m) => ({ default: m.PlayerStats })));
const Almanac = lazy(() => import("./pages/Almanac").then((m) => ({ default: m.Almanac })));
const ArchivedMatch = lazy(() => import("./pages/ArchivedMatch").then((m) => ({ default: m.ArchivedMatch })));
const Admin = lazy(() => import("./pages/Admin").then((m) => ({ default: m.Admin })));
const Support = lazy(() => import("./pages/Support").then((m) => ({ default: m.Support })));
// Read once, on the day somebody starts streaming, and never again - so it has no business being in
// the bundle a player firing at a board downloads. It drags in the scene generator and the sample.
const Streaming = lazy(() => import("./pages/Streaming").then((m) => ({ default: m.Streaming })));

/**
 * Every route that is composited into OBS must show nothing but the match state, so they opt out
 * of the app-wide chrome entirely rather than hiding it with CSS.
 *
 * The caster's CONTROL page is deliberately not in this list - it is an ordinary page on a second
 * monitor, and wants the top bar like anything else.
 */
const OVERLAY_ROUTES = [
  "/overlay/",
  "/overlay-board/",
  "/overlay-timer/",
  "/overlay-key/",
  "/overlay-odds/",
  "/overlay-fleet/",
  // Draws nothing at all, and still belongs here: the chrome would be the ONLY thing it drew.
  "/overlay-audio/",
  // Draws nothing for most of a match, which is the same argument.
  "/overlay-egg/",
  // Every persistent source, in one prefix. /stream/cast is the exception INSIDE that prefix - it is
  // a page on a second monitor rather than a source in a scene - so it is subtracted below rather
  // than the other six being listed one at a time.
  "/stream/",
];

/** The caster's desk, whichever door it was reached by, wants the top bar like any other page. */
const CHROME_ANYWAY = ["/stream/cast"];

function Chrome() {
  const { pathname } = useLocation();
  // The subtraction, not a separate branch: /stream/cast has to end up with exactly the chrome
  // /cast/:code already has, and a branch of its own is how the two quietly drift apart.
  const bare =
    OVERLAY_ROUTES.some((prefix) => pathname.startsWith(prefix)) &&
    !CHROME_ANYWAY.some((prefix) => pathname.startsWith(prefix));
  if (bare) return null;
  return (
    <>
      <TopBar />
      <BuildStamp />
    </>
  );
}

function App() {
  return (
    <HashRouter>
      <Chrome />
      {/* Inside the router so the fallback can be styled like the rest of the app, but outside the
          routes so a throw anywhere in a page still lands on it rather than on a blank document. */}
      <ErrorBoundary>
        {/* The same loading mark the room and the stats pages already show while they fetch, so a
            lazy route arriving looks like the app loading rather than like a blank frame. */}
        <Suspense fallback={<LoadingScreen>Loading...</LoadingScreen>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/room/:code" element={<Room />} />
          <Route path="/overlay/:code" element={<Overlay />} />
          {/* The caster's three browser sources, plus the page that drives the first of them.
              Only the board needs driving; the timer and the key follow the room on their own. */}
          <Route path="/overlay-board/:code" element={<OverlayBoard />} />
          <Route path="/overlay-timer/:code" element={<OverlayTimer />} />
          <Route path="/overlay-key/:code" element={<OverlayKey />} />
          {/* Each fleet's chance of winning, and the line that shows how it got there. Follows
              the room on its own like the clock does - see pages/OverlayOdds. */}
          <Route path="/overlay-odds/:code" element={<OverlayOdds />} />
          {/* The fifth source has no picture at all - see pages/OverlayAudio. It is in
              OVERLAY_ROUTES above for the same reason the rest are: a top bar rendered into a
              browser source is a top bar composited onto somebody's stream. */}
          <Route path="/overlay-audio/:code" element={<OverlayAudio />} />
          {/* A player's own fleet, small, for showing chat where their ships are. Not a caster
              source: it needs the owner's rejoin code and can only ever draw that one fleet. */}
          <Route path="/overlay-fleet/:code" element={<OverlayFleet />} />
          {/* Empty until the water gives something up - see pages/OverlayEgg. */}
          <Route path="/overlay-egg/:code" element={<OverlayEgg />} />
          <Route path="/cast/:code" element={<CasterControl />} />
          {/* The persistent sources: one route for every element above, told which room to draw by an
              overlay token rather than by a room code in the path. Nothing new renders here - see
              pages/StreamSource. `/stream/cast` shares the route and is the caster's desk, not a
              browser source. */}
          <Route path="/stream/:element" element={<StreamSource />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/player/:key" element={<PlayerStats />} />
          <Route path="/almanac" element={<Almanac />} />
          {/* match_key is `CODE:timestamp`, so it is URI-encoded into this slot and decoded back
              out in the page - the colons alone would still route, but the timestamp's `+` would
              not survive the round trip. */}
          <Route path="/match/:key" element={<ArchivedMatch />} />
          {/* Guarded inside the page, not here - the route has to exist for everyone so that an
              admin following a link into a fresh tab lands on it before the session is checked. */}
          <Route path="/admin" element={<Admin />} />
          {/* Reached from the footer on every page that has one, always in a new tab, so that
              reporting a bug never costs somebody the match they were reporting it about. */}
          <Route path="/support" element={<Support />} />
          {/* The two things a streamer sets up once: the persistent OBS overlay, and auto-marking.
              Reached from the top bar beside the bug report - see components/OutreachLinks. */}
          <Route path="/streaming" element={<Streaming />} />
        </Routes>
        </Suspense>
      </ErrorBoundary>
    </HashRouter>
  );
}

export default App;
