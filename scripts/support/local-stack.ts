/**
 * Shared setup for the checks that run against the LOCAL Supabase stack: reading its address and keys,
 * clients that survive the stack's occasional dropped connection, throwaway users, and cleanup.
 *
 * LOCAL ONLY. Everything here creates and deletes data, so it refuses to start unless the API is on
 * localhost. (The older check-*.mjs scripts read .env.local, which is the cloud project; nothing that
 * imports this file does.) Start the stack first:  npm run local:up
 */
import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

function localEnv(): Record<string, string> {
  const raw = execFileSync('npx', ['--yes', 'supabase@latest', 'status', '-o', 'env'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
  })
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\s*$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

const env = localEnv()
export const API = env.API_URL
export const ANON = env.ANON_KEY
export const SERVICE = env.SERVICE_ROLE_KEY
if (!API || !ANON || !SERVICE) {
  console.error('Could not read the local Supabase stack. Is it running? (npm run local:up)')
  process.exit(2)
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(API)) {
  console.error(`Refusing to run: ${API} is not a local address. This script creates and deletes data.`)
  process.exit(2)
}

/**
 * Node's fetch reuses keep-alive sockets, and the local gateway now and then closes one just as it is
 * picked up again, which surfaces as "TypeError: fetch failed" before the request reached the database.
 * Only network-level failures are retried - a refusal from the database is a normal response - and the
 * count is exported so a degrading stack shows up as a number rather than being quietly absorbed.
 */
export const retries = { count: 0 }
const retryingFetch: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(input, init)
    } catch (e) {
      if (attempt >= 9 || !(e instanceof TypeError)) throw e
      retries.count++
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

export const clientOpts = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: retryingFetch },
}

export const svc = createClient(API, SERVICE, clientOpts)

export function anonClient(): SupabaseClient {
  return createClient(API, ANON, clientOpts)
}

// -- harness ---------------------------------------------------------------------------------------

export const tally = { failures: 0 }

export function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${!ok && detail ? ` - ${detail}` : ''}`)
  if (!ok) tally.failures++
}

// -- throwaway people and events ---------------------------------------------------------------------

export const run = String(Math.floor(Math.random() * 90000) + 10000)

export interface Person {
  id: string
  login: string
  name: string
  client: SupabaseClient
  /** For signing in again from somewhere else - a browser, say - as this same person. */
  email: string
  password: string
}

const createdUsers: string[] = []
const createdTournaments: string[] = []

export function trackTournament(id: string) {
  createdTournaments.push(id)
}

export async function person(label: string, opts: { twitch?: boolean; admin?: boolean } = {}): Promise<Person> {
  const { twitch = true, admin = false } = opts
  const email = `t${run}${label}@test.local`
  const password = `pw-${run}-${label}`
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // What the app reads to decide someone signed in through Twitch (see profileFromUser). Harmless
    // for the database checks, and what lets a browser driven as this person show the signed-in UI.
    user_metadata: twitch ? { twitch_id: `${run}-${label}`, twitch_login: `t${run}${label}`.toLowerCase(), display_name: label, avatar_url: null } : {},
  })
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`)
  const id = data.user.id
  createdUsers.push(id)
  const login = `t${run}${label}`.toLowerCase()
  if (twitch) {
    const r = await svc.from('profiles').insert({ id, twitch_id: `${run}-${label}`, twitch_login: login, display_name: label })
    if (r.error) throw new Error(`profile ${label}: ${r.error.message}`)
  }
  if (admin) {
    const r = await svc.from('admins').insert({ user_id: id, display_name: label, is_owner: false })
    if (r.error) throw new Error(`admin ${label}: ${r.error.message}`)
  }
  const client = createClient(API, ANON, clientOpts)
  const signIn = await client.auth.signInWithPassword({ email, password })
  if (signIn.error) throw new Error(`sign in ${label}: ${signIn.error.message}`)
  return { id, login, name: label, client, email, password }
}

/** Removes everything this run created. Each step is attempted on its own, so one failure strands nothing after it. */
export async function cleanup() {
  const attempt = async (what: string, step: () => PromiseLike<{ error: { message: string } | null }>) => {
    try {
      const { error } = await step()
      if (error) console.log(`  (cleanup: ${what}: ${error.message})`)
    } catch (e) {
      console.log(`  (cleanup: ${what}: ${(e as Error).message})`)
    }
  }
  for (const id of createdTournaments) await attempt('tournament', () => svc.from('tournaments').delete().eq('id', id))
  for (const id of createdUsers) {
    await attempt('admin row', () => svc.from('admins').delete().eq('user_id', id))
    await attempt('profile', () => svc.from('profiles').delete().eq('id', id))
    await attempt('user', () => svc.auth.admin.deleteUser(id))
  }
}

/** Cleans up, prints the verdict, and exits with the right code. */
export async function finish(): Promise<never> {
  await cleanup()
  if (retries.count > 0) console.log(`\n(${retries.count} network-level retries against the local stack)`)
  console.log(tally.failures === 0 ? '\nAll checks passed.' : `\n${tally.failures} check(s) FAILED.`)
  process.exit(tally.failures === 0 ? 0 : 1)
}
