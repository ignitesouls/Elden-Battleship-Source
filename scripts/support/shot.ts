/**
 * Takes a screenshot of the running app in headless Chrome, optionally signed in as a given person,
 * optionally after clicking things - so screens that only exist for a signed-in player or an
 * administrator can be looked at.
 *
 * It drives Chrome through the DevTools protocol with nothing but Node's built-in WebSocket and fetch,
 * so there is nothing to install. It signs in by writing the person's session into the page's
 * localStorage before the app starts, which is exactly what a real sign-in leaves behind.
 *
 * LOCAL DEV TOOL. Point it at a dev server run against the local database (npm run dev:local).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

export interface ShotOptions {
  /** The app's origin and base path, e.g. http://localhost:5199/Elden-Battleship/ */
  base: string
  /** The route, e.g. "#/event/123". */
  route: string
  out: string
  /** A supabase-js session to sign in with; omit for an anonymous visitor. */
  session?: unknown
  /** Supabase's localStorage key for the session. Derived from the API host: sb-<first label>-auth-token. */
  storageKey?: string
  /** Further localStorage entries to set before the app starts - e.g. which player this browser is in a room. */
  storage?: Record<string, string>
  width?: number
  /** JavaScript run in the page after it has loaded, each followed by a short pause - to click things. */
  steps?: string[]
  settleMs?: number
}

/** A snippet that clicks the first button or link whose text contains `text`. */
export const clickText = (text: string) =>
  `(() => { const el = [...document.querySelectorAll('button, a')].find((b) => b.textContent && b.textContent.includes(${JSON.stringify(text)})); if (!el) throw new Error('nothing to click: ' + ${JSON.stringify(text)}); el.click(); return true })()`

/**
 * A snippet that clicks the button whose text contains `button`, but only inside the card (the nearest
 * enclosing block that also contains the text `within`). For pages that repeat the same button in
 * every row, where clicking "the first Approve" would be clicking the wrong one.
 */
export const clickIn = (within: string, button: string) =>
  // For each candidate button, find the NEAREST ancestor whose text mentions `within`, and click the
  // candidate whose such ancestor is the smallest. "Inside that card" means exactly that: the button
  // sharing the tightest block with the text. (An earlier version called anything under twelve buttons
  // a card, which stopped working the moment a page had few enough rows.)
  `(() => { let best = null, bestSize = Infinity; for (const x of document.querySelectorAll('button')) { if (!x.textContent || !x.textContent.includes(${JSON.stringify(button)})) continue; let n = x.parentElement; for (let i = 0; i < 10 && n; i++, n = n.parentElement) { if (n.textContent && n.textContent.includes(${JSON.stringify(within)})) { if (n.textContent.length < bestSize) { bestSize = n.textContent.length; best = x } break } } } if (!best) throw new Error('nothing to click: ' + ${JSON.stringify(`${button} in ${within}`)}); best.click(); return true })()`

/**
 * A snippet that types `value` into the input whose aria-label contains `label`. A React-controlled input
 * ignores a plain `el.value = ...`, so this goes through the native setter and fires the event React is
 * listening for, which is what typing does.
 */
export const setValue = (label: string, value: string) =>
  `(() => { const el = [...document.querySelectorAll('input')].find((i) => (i.getAttribute('aria-label') || '').includes(${JSON.stringify(label)})); if (!el) throw new Error('nothing to click: input ' + ${JSON.stringify(label)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function shot(opts: ShotOptions): Promise<void> {
  const browser = BROWSERS.find(existsSync)
  if (!browser) throw new Error('No Chrome or Edge found')
  const port = 9300 + Math.floor(Math.random() * 500)
  const profile = join(tmpdir(), `eb-shot-${port}`)
  mkdirSync(profile, { recursive: true })

  const child = spawn(
    browser,
    ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=800,900', 'about:blank'],
    { stdio: 'ignore' },
  )

  try {
    // Wait for the debugger to come up and find the page.
    let wsUrl = ''
    for (let i = 0; i < 40 && !wsUrl; i++) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
        wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? ''
      } catch {
        // not up yet
      }
      if (!wsUrl) await sleep(250)
    }
    if (!wsUrl) throw new Error('Chrome did not start')

    const ws = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('could not connect to Chrome'))
    })

    let nextId = 1
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
    const waiting = new Map<string, Array<() => void>>()
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result)
      } else if (msg.method) {
        for (const done of waiting.get(msg.method) ?? []) done()
        waiting.delete(msg.method)
      }
    }
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    const loaded = () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 15000)
        waiting.set('Page.loadEventFired', [...(waiting.get('Page.loadEventFired') ?? []), () => (clearTimeout(timer), resolve())])
      })
    const evaluate = async (expression: string) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'page script failed')
      return result.result?.value
    }

    await send('Page.enable')

    if (opts.session || opts.storage) {
      // Any same-origin document that does NOT run the app will do to write storage from. An image
      // does, and the app never sees a session-less start.
      let ready = loaded()
      await send('Page.navigate', { url: `${opts.base}logo.png` })
      await ready
      if (opts.session) {
        await evaluate(`localStorage.setItem(${JSON.stringify(opts.storageKey ?? 'sb-127-auth-token')}, ${JSON.stringify(JSON.stringify(opts.session))})`)
      }
      for (const [key, value] of Object.entries(opts.storage ?? {})) {
        await evaluate(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
      }
      ready = loaded()
      await send('Page.navigate', { url: 'about:blank' })
      await ready
    }

    const ready = loaded()
    await send('Page.navigate', { url: `${opts.base}${opts.route}` })
    await ready
    await sleep(opts.settleMs ?? 3500)

    for (const step of opts.steps ?? []) {
      // A page fetches its data after it loads, so the thing to click may not exist yet. Wait for it
      // (up to ~10s) rather than guessing how long the network takes; any OTHER failure is real.
      for (let attempt = 0; ; attempt++) {
        try {
          await evaluate(step)
          break
        } catch (e) {
          if (attempt >= 14 || !/nothing to click/.test((e as Error).message)) throw e
          await sleep(700)
        }
      }
      await sleep(1800)
    }

    const metrics = await send('Page.getLayoutMetrics')
    const height = Math.ceil(Math.max(600, metrics.cssContentSize?.height ?? metrics.contentSize.height))
    await send('Emulation.setDeviceMetricsOverride', { width: opts.width ?? 800, height, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    const image = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(opts.out, Buffer.from(image.data, 'base64'))
    ws.close()
  } finally {
    child.kill()
    await sleep(300)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      // Chrome may still hold a file; the OS temp folder will get it.
    }
  }
}
