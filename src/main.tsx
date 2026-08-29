import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyTeamPalette } from './lib/teamColors'
import { installEgressMeter } from './lib/egressMeter'

// Publish --team0..--teamN before first paint so teamHex()'s var() references resolve.
applyTeamPalette()

// Before the first render rather than from an effect: the site's opening reads go out while the
// first page mounts, and a meter installed later would miss exactly the burst it most wants to
// weigh. It wraps fetch and the realtime socket and reports nothing until a room is in the URL.
installEgressMeter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
