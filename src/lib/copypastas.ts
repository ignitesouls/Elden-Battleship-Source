import { supabase } from "./supabase";
import type { BarnacleMood } from "./talkingPoints";

/**
 * The community's copypastas, for the caster desk to put on stream - see the caster_copypastas
 * migration. Anyone reads them; only an administrator writes (RLS says so, not this file).
 */
export interface Copypasta {
  id: string;
  title: string;
  body: string;
  mood: BarnacleMood;
  sort: number;
}

/** The limits the table enforces, so the editor can say so before the server refuses. */
export const COPYPASTA_TITLE_MAX = 60;
export const COPYPASTA_BODY_MAX = 600;

const COLUMNS = "id, title, body, mood, sort";

/** Every copypasta, in the desk's order - one request. */
export async function fetchCopypastas(): Promise<Copypasta[]> {
  const { data, error } = await supabase
    .from("caster_copypastas")
    .select(COLUMNS)
    .order("sort", { ascending: true })
    .order("title", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Copypasta[];
}

/** Adds a copypasta, or saves over one when it has an id (administrators). */
export async function saveCopypasta(c: Omit<Copypasta, "id"> & { id?: string }): Promise<void> {
  const row = { title: c.title.trim(), body: c.body.trim(), mood: c.mood, sort: c.sort };
  const { error } = c.id
    ? await supabase.from("caster_copypastas").update(row).eq("id", c.id)
    : await supabase.from("caster_copypastas").insert(row);
  if (error) throw new Error(error.message);
}

/** Retires a copypasta for good (administrators). */
export async function deleteCopypasta(id: string): Promise<void> {
  const { error } = await supabase.from("caster_copypastas").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/**
 * A copypasta's text with tonight's teams put in: `<Team 1>` and `<Team 2>` become the two names, so the
 * barnacle says "better for Alpha" rather than reading the placeholder out. Case and spacing inside the
 * brackets are forgiven. A team that isn't known yet - nobody seated on a fleet, no official match - is
 * said as plain "Team 1", never with the brackets, which read as a broken overlay on stream.
 */
export function fillTeams(text: string, teams: [string | null, string | null]): string {
  return text.replace(/<\s*team\s*([12])\s*>/gi, (_whole, n: string) => teams[Number(n) - 1] ?? `Team ${n}`);
}

/**
 * How long a card with this much to read stays up: long enough to read it out, never shorter than a
 * talking point's and never past the frame's own cap (see useFrameCards). About 20 characters a second.
 */
export function readingMs(text: string, floor: number): number {
  return Math.max(floor, Math.min(25_000, 3000 + text.length * 50));
}
