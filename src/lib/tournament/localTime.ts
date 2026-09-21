/**
 * An ISO timestamp as the value of a datetime-local input: "YYYY-MM-DDTHH:mm", in the viewer's own time
 * zone. (Not toISOString().slice(0, 16), which is UTC and would show every time shifted by the viewer's
 * offset - an agreed 8pm would read as 1am.) Empty for a missing or unreadable timestamp.
 */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The other direction: a datetime-local value back to an ISO timestamp, or null if it is empty. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
