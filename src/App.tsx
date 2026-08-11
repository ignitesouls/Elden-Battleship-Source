import { HashRouter, Routes, Route, useLocation } from "react-router-dom";
import { Home } from "./pages/Home";
import { Room } from "./pages/Room";
import { Overlay } from "./pages/Overlay";
import { OverlayBoard } from "./pages/OverlayBoard";
import { OverlayTimer } from "./pages/OverlayTimer";
import { OverlayKey } from "./pages/OverlayKey";
import { CasterControl } from "./pages/CasterControl";
import { Leaderboard } from "./pages/Leaderboard";
import { PlayerStats } from "./pages/PlayerStats";
import { Almanac } from "./pages/Almanac";
import { ArchivedMatch } from "./pages/ArchivedMatch";
import { TopBar } from "./components/TopBar";
import { BuildStamp } from "./components/BuildStamp";
import { ErrorBoundary } from "./components/ErrorBoundary";

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
        </Routes>
      </ErrorBoundary>
    </HashRouter>
  );
}

export default App;
