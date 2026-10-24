import type { BarnacleMood } from "./talkingPoints";

/** The four barnacles that say things on stream (public/media/barnacles) - see BarnacleMood. */
export const BARNACLE_MOODS: readonly BarnacleMood[] = ["happy", "smug", "grim", "angry"];

/** One barnacle's picture. An unknown mood (an older desk) gets the smug one. */
export function barnacleSrc(mood: string | undefined): string {
  const known = (BARNACLE_MOODS as readonly string[]).includes(mood ?? "") ? mood : "smug";
  return `${import.meta.env.BASE_URL}media/barnacles/barnacle-${known}.png`;
}
