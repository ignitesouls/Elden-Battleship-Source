import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * A human-comparable build identifier, baked in at compile time.
 *
 * GitHub Pages caches index.html hard, so after an upload some players keep running the previous
 * bundle until they hard-refresh - and a stale client desyncing mid-match is very difficult to
 * diagnose over voice chat. Printing this in the corner turns that into "read me your build
 * number". The timestamp is the primary signal because it changes on every build; the commit is
 * a bonus and is omitted rather than guessed if git isn't available (e.g. a CI zip export).
 */
function buildId(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    return `${stamp} · ${sha}`
  } catch {
    return stamp
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  // GitHub Pages serves this at https://kcbrazos.github.io/Elden-Battleship/, so every asset
  // URL needs that prefix baked in at build time. This MUST match the repository name exactly
  // (case included) - if it doesn't, the deployed page loads but every script, sprite and sound
  // 404s, which presents as a silent blank screen rather than an error.
  //
  // Using HashRouter means no server-side rewrite rules are needed for deep links like
  // #/room/SALTYKRAKEN, which is why dropping the dist/ folder into a repo just works.
  base: '/Elden-Battleship/',
})
