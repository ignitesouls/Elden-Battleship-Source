import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyTeamPalette } from './lib/teamColors'

// Publish --team0..--teamN before first paint so teamHex()'s var() references resolve.
applyTeamPalette()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
