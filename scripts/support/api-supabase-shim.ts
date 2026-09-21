/**
 * Stands in for src/lib/supabase.ts when the tournament API is run under plain Node.
 *
 * The real module builds its client from Vite's import.meta.env, which does not exist outside a Vite
 * build. This one exports the same `supabase` binding, and lets a check swap in whichever signed-in
 * client it wants to act as - so the SAME api.ts functions the pages call can be run as an admin, a
 * captain, an invitee or a stranger. It is a live binding: reassigning it here changes what api.ts sees.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export let supabase!: SupabaseClient

export function actAs(client: SupabaseClient) {
  supabase = client
}
