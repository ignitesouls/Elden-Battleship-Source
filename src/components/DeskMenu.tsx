import { useEffect, useState, type ReactNode } from "react";

/** Which desk menus were left open, kept in this browser between shows. Best-effort either way. */
const OPEN_KEY = "eb_desk_menus";

function readOpen(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeOpen(id: string, open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify({ ...readOpen(), [id]: open }));
  } catch {
    /* just won't be remembered next time */
  }
}

/**
 * One collapsible group of the caster desk's controls (pages/CasterControl).
 *
 * The desk's right-hand column had grown to seventeen sections in one long scroll. Grouped into a few
 * of these, a caster opens the two or three they actually use during a show and leaves the rest shut,
 * and each one stays the way it was left from one show to the next.
 *
 * `locked` is for the groups that aim or dress the board when another caster holds it (lib/castDesks):
 * the group still opens - the caster can see what is set - but nothing inside can be touched. The
 * header says so, because a menu that opens onto controls that ignore every click reads as broken.
 *
 * `openSignal` opens the group from outside - the pinned talking point's jump to the full list. Any
 * change to it opens; the caster closing it again is their call.
 */
export function DeskMenu({
  id,
  title,
  defaultOpen = false,
  locked = false,
  lockedNote,
  openSignal,
  children,
}: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  locked?: boolean;
  lockedNote?: string;
  openSignal?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readOpen()[id] ?? defaultOpen);

  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  return (
    <details
      className="cast-menu"
      open={open}
      onToggle={(e) => {
        const now = e.currentTarget.open;
        if (now === open) return;
        setOpen(now);
        writeOpen(id, now);
      }}
    >
      <summary className="cast-menu-head">
        <span>{title}</span>
        {locked && lockedNote && <span className="cast-status">{lockedNote}</span>}
      </summary>
      <div className="cast-menu-body" inert={locked}>
        {children}
      </div>
    </details>
  );
}
