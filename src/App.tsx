import { Suspense, lazy } from "react";
import { HashRouter, Routes, Route, useLocation } from "react-router-dom";
import { Home } from "./pages/Home";
import { Room } from "./pages/Room";
import { Overlay } from "./pages/Overlay";
import { OverlayBoard } from "./pages/OverlayBoard";
import { OverlayTimer } from "./pages/OverlayTimer";
import { OverlayKey } from "./pages/OverlayKey";
import { CasterControl } from "./pages/CasterControl";
import { TopBar } from "./components/TopBar";
import { BuildStamp } from "./components/BuildStamp";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LoadingScreen } from "./components/BrandMark";

/**
 * The browsing pages, fetched on demand rather than baked into the bundle everything else loads.
 *
 * Every route above is a page somebody is in the middle of a match on - the join form, the room
 * itself, the four OBS browser sources, and the caster's desk - and those stay eagerly imported so
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

/**
 * Every route that is composited into OBS must show nothing but the match state, so they opt out
 * of the app-wide chrome entirely rather than hiding it with CSS.
 *
 * The caster's CONTROL page is deliberately not in this list - it is an ordinary page on a second
 * monitor, and wants the top bar like anything else.
 */
const OVERLAY_ROUTES = ["/overlay/", "/overlay-board/", "/overlay-timer/", "/overlay-key/"];

function Chrome() {
  const { pathname } = useLocation();
  if (OVERLAY_ROUTES.some((prefix) => pathname.startsWith(prefix))) return null;
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
          <Route path="/cast/:code" element={<CasterControl />} />
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
        </Routes>
        </Suspense>
      </ErrorBoundary>
    </HashRouter>
  );
}

export default App;
